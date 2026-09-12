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
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const API_BASE = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const VERSION = '1.0.0';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RestClient {
  constructor(token) {
    this.token = token;
  }

  async request(method, path, { body, query } = {}) {
    const url = new URL(API_BASE + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bot ${this.token}`,
          'User-Agent': `DiscordLiveDashboard (local, ${VERSION})`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429) {
        let wait = 1;
        try {
          const j = await res.json();
          wait = Number(j.retry_after) || 1;
        } catch {
          /* ignore */
        }
        await sleep(wait * 1000 + 300);
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
        const message =
          (json && (json.message || json.error)) || text || `HTTP ${res.status}`;
        const err = new Error(`Discord REST ${method} ${path} -> ${res.status}: ${message}`);
        err.status = res.status;
        err.discordBody = json;
        throw err;
      }
      return json;
    }
    throw new Error(`Discord REST ${method} ${path}: gave up after repeated 429s`);
  }

  getMe() {
    return this.request('GET', '/users/@me');
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
    this.rest = new RestClient(token);

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
  }

  log(...args) {
    if (this.debug) console.log('[gateway]', ...args);
  }

  async start() {
    this.user = await this.rest.getMe();
    this.emit('user', this.user);
    await this.connect(GATEWAY_URL);
    return this.user;
  }

  connect(url) {
    return new Promise((resolve) => {
      this.emit('state', { state: 'connecting', error: null });
      this.log('connecting to', url.split('?')[0]);
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.log('socket open');
        resolve();
      });

      this.ws.on('message', (raw) => {
        let payload;
        try {
          payload = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this.handlePayload(payload);
      });

      this.ws.on('close', (code, reason) => {
        this.log('socket closed', code, reason && reason.toString());
        this.handleClose(code);
      });

      this.ws.on('error', (err) => {
        this.log('socket error', err.message);
        this.emit('error', err);
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
        this.guildIds = new Set((data.guilds || []).map((g) => g.id));
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
      const url =
        resumable && this.resumeGatewayUrl ? `${this.resumeGatewayUrl}/?v=10&encoding=json` : GATEWAY_URL;
      this.connect(url).catch((err) => this.emit('error', err));
    }, delay);
  }

  handleClose(code) {
    clearInterval(this.heartbeatTimer);
    if (this.closedByUser) return;

    if (FATAL_CLOSE_CODES.has(code)) {
      const hints = {
        4004: 'Invalid bot token - check DISCORD_BOT_TOKEN.',
        4010: 'Invalid shard.',
        4011: 'Sharding required.',
        4012: 'Invalid gateway intents - enable them in the Developer Portal.',
        4013: 'Invalid intents value.',
        4014: 'Disallowed intents - enable the privileged intents in the Developer Portal.',
      };
      this.emit('state', {
        state: 'error',
        error: `Gateway closed with fatal code ${code}. ${hints[code] || ''}`.trim(),
      });
      return;
    }

    const canResume = Boolean(this.sessionId) && ![1000, 4007, 4009].includes(code);
    this.reconnect(canResume);
  }

  destroy() {
    this.closedByUser = true;
    clearInterval(this.heartbeatTimer);
    try {
      if (this.ws) this.ws.close(1000, 'dashboard shutting down');
    } catch {
      /* ignore */
    }
  }
}

module.exports = { DiscordClient, RestClient, Intents, DEFAULT_INTENTS, GATEWAY_URL, API_BASE };
