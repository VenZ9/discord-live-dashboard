'use strict';

/**
 * Minimal, dependency-light Discord client.
 *
 * Two halves:
 *   1. RestClient  - thin wrapper over the v10 REST API with rate-limit retry.
 *   2. DiscordClient - the Gateway (WebSocket) connection: HELLO / IDENTIFY /
 *      RESUME, heartbeats with zombie detection, and dispatch fan-out.
 *
 * It intentionally implements only what the dashboard needs, so the whole
 * real-time path is readable in one file.
 *
 * ---------------------------------------------------------------------------
 * v1.0.1 reliability fixes (see RENDER_DEPLOY.md for the incident write-up):
 *   * Discord-compliant User-Agent. A bare custom UA can be rejected by
 *     Discord's edge (Cloudflare), which surfaces as HTTP 429, not 401.
 *   * REST layer honours `retry_after` / `x-ratelimit-reset-after`, retries 5xx
 *     and network errors, and only gives up after a real budget is spent.
 *   * `start()` never blocks on the gateway handshake. Previously the HTTP
 *     server only started AFTER the gateway socket opened, so a stall meant the
 *     port never bound, Render marked the deploy failed, and the browser sat on
 *     "connecting" with a generic error.
 *   * The bot identity is taken from the gateway READY payload, so a transient
 *     REST failure at boot no longer leaves the dashboard permanently dead.
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const API_BASE = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const VERSION = '1.0.1';

/**
 * Discord expects a User-Agent of the form `DiscordBot ($url, $versionNumber)`.
 * Override with DISCORD_UA if you fork this and want your own URL there.
 */
const USER_AGENT =
  process.env.DISCORD_UA || `DiscordBot (https://github.com/VenZ9/discord-live-dashboard, ${VERSION})`;

/** Gateway intents. See https://discord.com/developers/docs/topics/gateway#gateway-intents */
const Intents = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MODERATION: 1 << 2,
  GUILD_EMOJIS_AND_STICKERS: 1 << 3,
  GUILD_INTEGRATIONS: 1 << 4,
  GUILD_WEBHOOKS: 1 << 5,
  GUILD_INVITES: 1 << 6,
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_PRESENCES: 1 << 8,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
};

/** Everything the dashboard needs: servers, members, presences, messages. */
const DEFAULT_INTENTS =
  Intents.GUILDS |
  Intents.GUILD_MEMBERS |
  Intents.GUILD_PRESENCES |
  Intents.GUILD_MESSAGES |
  Intents.DIRECT_MESSAGES |
  Intents.MESSAGE_CONTENT;

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  RESUME: 6,
  RECONNECT: 7,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

/** Close codes we must not reconnect on. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/** Close-code -> human explanation, surfaced in the dashboard. */
const CLOSE_HINTS = {
  4004: 'Invalid bot token - the DISCORD_BOT_TOKEN value is wrong or was reset.',
  4010: 'Invalid shard.',
  4011: 'Sharding required.',
  4012: 'Invalid gateway intents - enable them in the Developer Portal.',
  4013: 'Invalid intents value.',
  4014: 'Disallowed intents - turn ON "Server Members" and "Message Content" under Bot > Privileged Gateway Intents.',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Discord returns `retry_after` in SECONDS for the v10 JSON body, but some
 * proxy/edge responses carry milliseconds. Treat anything implausibly large as
 * milliseconds so we never sleep for thousands of seconds by accident.
 */
function normaliseRetryAfter(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 100 ? n / 1000 : n;
}

class RestClient {
  constructor(token, { debug = false } = {}) {
    this.token = token;
    this.debug = debug;
    /** Absolute time (ms) we must not issue another request before. */
    this.globalBlockedUntil = 0;
  }

  log(...args) {
    if (this.debug) console.log('[rest]', ...args);
  }

  async request(method, path, { body, query, maxAttempts = 5 } = {}) {
    const url = new URL(API_BASE + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }

    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Respect a global rate-limit lock before even opening a socket.
      const wait = this.globalBlockedUntil - Date.now();
      if (wait > 0) {
        this.log(`globally rate-limited, waiting ${Math.round(wait)}ms`);
        await sleep(wait);
      }

      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bot ${this.token}`,
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        // DNS / TLS / connection reset - always retryable.
        lastError = new Error(`Discord REST ${method} ${path}: network error: ${err.message}`);
        lastError.status = 0;
        lastError.cause = err;
        this.log(`network error (attempt ${attempt}/${maxAttempts}):`, err.message);
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.random() * 250);
        continue;
      }

      // --- 429: rate limited. Honour retry_after / reset-after, then retry. ---
      if (res.status === 429) {
        let bodyJson = null;
        try {
          const raw = await res.text();
          bodyJson = raw ? JSON.parse(raw) : null;
        } catch {
          /* non-JSON body */
        }

        const header = res.headers.get('x-ratelimit-reset-after') || res.headers.get('retry-after');
        const seconds =
          normaliseRetryAfter(bodyJson && bodyJson.retry_after) ?? normaliseRetryAfter(header) ?? 1;
        const isGlobal =
          Boolean(bodyJson && bodyJson.global) || res.headers.get('x-ratelimit-scope') === 'global';
        const delayMs = seconds * 1000 + 250 + Math.random() * 250;

        if (isGlobal) this.globalBlockedUntil = Date.now() + delayMs;

        this.log(
          `429 (${isGlobal ? 'global' : 'route'}) on ${path} - retry_after=${seconds}s ` +
            `(attempt ${attempt}/${maxAttempts})`
        );

        lastError = new Error(
          `Discord REST ${method} ${path} -> 429 rate limited${isGlobal ? ' (global)' : ''}; retry after ${seconds}s`
        );
        lastError.status = 429;

        // Always wait out a 429 even on the final attempt, so a caller that
        // retries later does not immediately hit the same bucket again.
        await sleep(delayMs);
        continue;
      }

      // --- 5xx: transient Discord/edge failure. Retry with backoff. ---
      if (res.status >= 500) {
        lastError = new Error(`Discord REST ${method} ${path} -> ${res.status} ${res.statusText}`);
        lastError.status = res.status;
        this.log(`server error ${res.status} (attempt ${attempt}/${maxAttempts})`);
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.random() * 250);
        continue;
      }

      if (res.status === 204) return null;

      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON body */
      }

      if (!res.ok) {
        const message = (json && (json.message || json.error)) || text || `HTTP ${res.status}`;
        const err = new Error(`Discord REST ${method} ${path} -> ${res.status}: ${message}`);
        err.status = res.status;
        err.discordBody = json;
        throw err; // 4xx other than 429 is not retryable.
      }

      // Pre-emptively note an exhausted bucket so the next call waits.
      const remaining = res.headers.get('x-ratelimit-remaining');
      const resetAfter = normaliseRetryAfter(res.headers.get('x-ratelimit-reset-after'));
      if (remaining === '0' && resetAfter) {
        this.globalBlockedUntil = Math.max(
          this.globalBlockedUntil,
          Date.now() + resetAfter * 1000 + 150
        );
      }

      return json;
    }

    throw (
      lastError || new Error(`Discord REST ${method} ${path}: failed after ${maxAttempts} attempts`)
    );
  }

  getMe({ maxAttempts = 5 } = {}) {
    return this.request('GET', '/users/@me', { maxAttempts });
  }

  /** with_counts gives approximate_member_count / approximate_presence_count
   *  even when the privileged GUILD_PRESENCES intent is disabled. */
  getGuild(guildId) {
    return this.request('GET', `/guilds/${guildId}`, { query: { with_counts: 'true' } });
  }

  getGuildChannels(guildId) {
    return this.request('GET', `/guilds/${guildId}/channels`);
  }

  getChannel(channelId) {
    return this.request('GET', `/channels/${channelId}`);
  }

  /** Newest-first list of messages (Discord returns newest first). */
  getChannelMessages(channelId, limit = 100) {
    return this.request('GET', `/channels/${channelId}/messages`, {
      query: { limit: Math.min(100, Math.max(1, limit)) },
    });
  }
}

class DiscordClient extends EventEmitter {
  constructor(token, { intents = DEFAULT_INTENTS, debug = false } = {}) {
    super();
    if (!token) throw new Error('DiscordClient requires a bot token.');
    this.token = token;
    this.intents = intents;
    this.debug = debug;
    this.rest = new RestClient(token, { debug });

    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.heartbeatInterval = null;
    this.heartbeatTimer = null;
    this.ackedFirstHeartbeat = true;
    this.closedByUser = false;
    this.user = null;
    this.guildIds = new Set();
    this.reconnectAttempts = 0;
    this.nonce = 0;
    this.pendingMemberRequests = new Map();
    /** Timer for the background REST identity probe. */
    this.identityProbeTimer = null;
    /** Set once we have seen READY at least once. */
    this.everReady = false;
  }

  log(...args) {
    if (this.debug) console.log('[gateway]', ...args);
  }

  emitState(state, error) {
    this.emit('state', { state, error: error || null });
  }

  /**
   * Start the client. Deliberately NON-BLOCKING with respect to the gateway
   * handshake: it resolves as soon as the socket is connecting, so the HTTP
   * server can bind its port immediately and the deploy can never be marked
   * failed just because Discord is slow or unreachable.
   */
  async start() {
    // 1. Best-effort identity fetch. Failure here is NOT fatal - the gateway
    //    READY payload carries the same information.
    try {
      this.user = await this.rest.getMe({ maxAttempts: 3 });
      this.emit('user', this.user);
      this.log('identified via REST as', this.user.username);
    } catch (err) {
      this.log('REST identity probe failed (continuing to the gateway):', err.message);
      this.emit('identityPending', { error: err.message });
      this.scheduleIdentityProbe();
    }

    // 2. Open the socket. Resolves on socket open, NOT on READY, and never
    //    rejects - reconnection is handled internally.
    await this.connect(GATEWAY_URL);
    return this.user;
  }

  /**
   * Retry the REST identity probe in the background until it succeeds. This is
   * what turns "gave up after repeated 429s" from a permanent dead state into a
   * self-healing one.
   */
  scheduleIdentityProbe(attempt = 0) {
    if (this.closedByUser) return;
    clearTimeout(this.identityProbeTimer);
    const delay = Math.min(60000, 5000 * 2 ** Math.min(attempt, 4));
    this.identityProbeTimer = setTimeout(async () => {
      if (this.closedByUser) return;
      try {
        this.user = await this.rest.getMe({ maxAttempts: 2 });
        this.emit('user', this.user);
        this.log('identity probe succeeded on retry');
      } catch (err) {
        this.log(`identity probe still failing (attempt ${attempt + 1}):`, err.message);
        this.scheduleIdentityProbe(attempt + 1);
      }
    }, delay);
    if (this.identityProbeTimer.unref) this.identityProbeTimer.unref();
  }

  /**
   * Open a gateway socket. Resolves as soon as the underlying socket is open
   * (or immediately on error/rejection); it never waits for READY and never
   * rejects, so callers cannot hang on it.
   */
  connect(url) {
    return new Promise((resolve) => {
      this.emitState('connecting');
      this.log('connecting to', url.split('?')[0]);

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        this.log('could not construct WebSocket:', err.message);
        this.emit('error', err);
        done();
        this.reconnect(false);
        return;
      }
      this.ws = ws;

      // Guard: if the handshake has not opened within 20s, treat it as dead and
      // start a fresh attempt. Without this a silently dropped SYN would leave
      // us "connecting" forever.
      const handshakeTimeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          this.log('handshake timed out after 20s - retrying');
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
          done();
          this.handleClose(1006);
        }
      }, 20000);
      if (handshakeTimeout.unref) handshakeTimeout.unref();

      ws.on('open', () => {
        clearTimeout(handshakeTimeout);
        this.log('socket open');
        this.reconnectAttempts = 0;
        done();
      });

      ws.on('message', (raw) => {
        let payload;
        try {
          payload = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this.handlePayload(payload);
      });

      ws.on('close', (code, reason) => {
        clearTimeout(handshakeTimeout);
        this.log('socket closed', code, reason && reason.toString());
        done();
        this.handleClose(code);
      });

      ws.on('error', (err) => {
        clearTimeout(handshakeTimeout);
        this.log('socket error', err.message);
        this.emit('error', err);
        done(); // never let the caller hang
      });
    });
  }

  handlePayload(payload) {
    const { op, d, t, s } = payload;
    if (s !== null && s !== undefined) this.seq = s;

    switch (op) {
      case OP.HELLO: {
        this.heartbeatInterval = d.heartbeat_interval;
        this.startHeartbeat();
        if (this.sessionId && this.seq !== null) {
          this.send({ op: OP.RESUME, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
          this.log('sent RESUME');
        } else {
          this.send({
            op: OP.IDENTIFY,
            d: {
              token: this.token,
              intents: this.intents,
              properties: { os: process.platform, browser: 'discord-live-dashboard', device: 'discord-live-dashboard' },
              presence: { status: 'online', since: 0, afk: false, activities: [{ name: 'monitoring servers', type: 0 }] },
            },
          });
          this.log('sent IDENTIFY (intents=' + this.intents + ')');
        }
        break;
      }

      case OP.DISPATCH: {
        this.handleDispatch(t, d);
        break;
      }

      case OP.HEARTBEAT: {
        this.sendHeartbeat();
        break;
      }

      case OP.RECONNECT: {
        this.log('gateway asked us to reconnect');
        this.reconnect(false);
        break;
      }

      case OP.INVALID_SESSION: {
        const resumable = Boolean(d);
        this.log('INVALID_SESSION, resumable =', resumable);
        if (!resumable) {
          this.sessionId = null;
          this.seq = null;
        }
        setTimeout(() => this.reconnect(resumable), 1000 + Math.random() * 4000);
        break;
      }

      case OP.HEARTBEAT_ACK: {
        this.ackedFirstHeartbeat = true;
        break;
      }

      default:
        break;
    }
  }

  handleDispatch(type, data) {
    if (!type) return;

    switch (type) {
      case 'READY': {
        this.sessionId = data.session_id;
        this.resumeGatewayUrl = data.resume_gateway_url;
        this.reconnectAttempts = 0;
        this.everReady = true;
        this.guildIds = new Set((data.guilds || []).map((g) => g.id));

        // The gateway is authoritative for identity: if the REST probe failed
        // at boot we still learn who we are, so the UI is never blank.
        if (!this.user && data.user) {
          this.user = data.user;
          this.emit('user', this.user);
          this.log('identified from READY payload as', data.user.username);
          clearTimeout(this.identityProbeTimer);
        }
        this.emit('ready', data);
        break;
      }

      case 'RESUMED': {
        this.emit('resumed', data);
        break;
      }

      case 'GUILD_CREATE': {
        this.guildIds.add(data.id);
        this.emit('guildCreate', data);
        break;
      }
      case 'GUILD_UPDATE':
        this.emit('guildUpdate', data);
        break;
      case 'GUILD_DELETE': {
        this.guildIds.delete(data.id);
        this.emit('guildDelete', data);
        break;
      }

      case 'CHANNEL_CREATE':
        this.emit('channelCreate', data);
        break;
      case 'CHANNEL_UPDATE':
        this.emit('channelUpdate', data);
        break;
      case 'CHANNEL_DELETE':
        this.emit('channelDelete', data);
        break;

      case 'GUILD_MEMBER_ADD':
        this.emit('guildMemberAdd', data);
        break;
      case 'GUILD_MEMBER_UPDATE':
        this.emit('guildMemberUpdate', data);
        break;
      case 'GUILD_MEMBER_REMOVE':
        this.emit('guildMemberRemove', data);
        break;
      case 'GUILD_MEMBERS_CHUNK': {
        const waiter = this.pendingMemberRequests.get(data.nonce);
        if (waiter) {
          waiter.received += (data.members || []).length;
          if (waiter.received >= (waiter.limit || 0)) {
            this.pendingMemberRequests.delete(data.nonce);
            waiter.resolve();
          }
        }
        this.emit('guildMembersChunk', data);
        break;
      }

      case 'PRESENCE_UPDATE':
        this.emit('presenceUpdate', data);
        break;

      case 'MESSAGE_CREATE':
        this.emit('messageCreate', data);
        break;
      case 'MESSAGE_UPDATE':
        this.emit('messageUpdate', data);
        break;
      case 'MESSAGE_DELETE':
        this.emit('messageDelete', data);
        break;

      default:
        this.emit('dispatch', { type, data });
        break;
    }
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.ackedFirstHeartbeat = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.ackedFirstHeartbeat) {
        this.log('no heartbeat ACK - assuming zombie connection, reconnecting');
        this.reconnect(false);
        return;
      }
      this.ackedFirstHeartbeat = false;
      this.sendHeartbeat();
    }, this.heartbeatInterval);
  }

  sendHeartbeat() {
    this.send({ op: OP.HEARTBEAT, d: this.seq });
  }

  /**
   * Ask Discord to stream the full member list (and presences) for a guild.
   * Requires the privileged GUILD_MEMBERS intent; without it Discord simply
   * stays silent, which is why the caller also falls back to REST counts.
   */
  requestGuildMembers(guildId, { limit = 0, presences = true, timeout = 15000 } = {}) {
    const nonce = String(++this.nonce);
    return new Promise((resolve) => {
      this.pendingMemberRequests.set(nonce, { resolve, received: 0, limit: limit || Infinity });
      const ok = this.send({
        op: OP.REQUEST_GUILD_MEMBERS,
        d: { guild_id: guildId, query: '', limit, presences, nonce },
      });
      if (!ok) {
        this.pendingMemberRequests.delete(nonce);
        resolve(false);
        return;
      }
      setTimeout(() => {
        if (this.pendingMemberRequests.has(nonce)) {
          this.pendingMemberRequests.delete(nonce);
          resolve(false);
        } else {
          resolve(true);
        }
      }, timeout);
    });
  }

  reconnect(resumable) {
    if (this.closedByUser) return;
    clearInterval(this.heartbeatTimer);
    try {
      if (this.ws) this.ws.removeAllListeners();
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000);
    } catch {
      /* ignore */
    }
    if (!resumable) {
      this.sessionId = null;
      this.seq = null;
    }
    this.reconnectAttempts++;
    const delay = Math.min(30000, 1000 * Math.pow(1.7, Math.min(this.reconnectAttempts, 7)));
    this.log(`reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => {
      if (this.closedByUser) return;
      const url =
        resumable && this.resumeGatewayUrl
          ? `${this.resumeGatewayUrl}/?v=10&encoding=json`
          : GATEWAY_URL;
      this.connect(url).catch((err) => this.emit('error', err));
    }, delay);
  }

  handleClose(code) {
    clearInterval(this.heartbeatTimer);
    if (this.closedByUser) return;

    if (FATAL_CLOSE_CODES.has(code)) {
      const hint = CLOSE_HINTS[code] || '';
      this.emitState('error', `Gateway closed with fatal code ${code}. ${hint}`.trim());
      return;
    }

    const canResume = Boolean(this.sessionId) && ![1000, 4007, 4009].includes(code);
    this.reconnect(canResume);
  }

  destroy() {
    this.closedByUser = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.identityProbeTimer);
    try {
      if (this.ws) this.ws.close(1000, 'dashboard shutting down');
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  DiscordClient,
  RestClient,
  Intents,
  DEFAULT_INTENTS,
  GATEWAY_URL,
  API_BASE,
  USER_AGENT,
};
