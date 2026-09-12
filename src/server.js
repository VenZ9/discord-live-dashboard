'use strict';

/**
 * Discord Live Dashboard - HTTP server.
 *
 * Pipeline:  Discord Gateway (WebSocket) -> DiscordClient events -> Store
 *            -> SSE broadcast -> browser dashboard.
 *
 * In demo mode a synthetic client emits the same events, so the live path can
 * be verified without a bot token.
 *
 * ---------------------------------------------------------------------------
 * v1.0.1 reliability fixes (the "stuck on connecting" incident):
 *
 *   * ORDERING. `app.listen(PORT)` now runs FIRST, before anything touches
 *     Discord. Previously the HTTP server was only started after
 *     `client.start()` resolved, and that promise only resolved once the
 *     gateway socket was fully open - so a slow or blocked gateway handshake
 *     meant the port never bound. On a platform that health-checks the port
 *     (Render), that is reported as a FAILED DEPLOY, and the browser shows
 *     "connecting" with a generic error.
 *
 *   * SELF-HEALING. Startup errors are no longer terminal. A fatal state is
 *     retried in the background on a backoff, so fixing the token or enabling
 *     the privileged intents recovers the dashboard without a redeploy.
 *
 *   * HONEST HEALTH. /api/health and /api/diagnostics report whether a token is
 *     configured, the last error and when it happened, and the gateway attempt
 *     count - so the failure is visible without digging through logs.
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const { Store } = require('./state');
const { DiscordClient, USER_AGENT } = require('./discord');
const { DemoClient } = require('./demo');

// --------------------------------------------------------------------- config

const PORT = Number(process.env.PORT || 3000);
const TOKEN = (process.env.DISCORD_BOT_TOKEN || '').trim();
const FORCE_DEMO = process.env.DEMO_MODE === '1' || process.argv.includes('--demo');
const DEMO = FORCE_DEMO || !TOKEN;
const HISTORY_LIMIT = Math.min(100, Math.max(1, Number(process.env.HISTORY_LIMIT || 100)));
const MAX_MESSAGES = Math.max(HISTORY_LIMIT, Number(process.env.MAX_MESSAGES_PER_CHANNEL || 200));
const GUILD_FILTER = (process.env.GUILD_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DEBUG = process.env.DEBUG === '1';
const REFRESH_MS = Number(process.env.COUNT_REFRESH_MS || 60000);
/** Backoff before retrying a fatal Discord startup error. */
const FATAL_RETRY_MS = Number(process.env.FATAL_RETRY_MS || 5 * 60 * 1000);

const store = new Store({ maxMessages: MAX_MESSAGES });
const listeners = new Set();
let client = null;

/** Diagnostic bookkeeping surfaced through /api/health. */
const diag = {
  tokenConfigured: Boolean(TOKEN),
  demoConfigured: DEMO,
  gatewayAttempts: 0,
  lastError: null,
  lastErrorAt: null,
  readySince: null,
  fatalRetryTimer: null,
  userAgent: USER_AGENT,
};

function noteError(message) {
  diag.lastError = message || null;
  diag.lastErrorAt = message ? new Date().toISOString() : null;
  if (message) console.error('[dashboard] error:', message);
}

// ------------------------------------------------------------------- SSE glue

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* client vanished mid-write; the close handler will clean up */
  }
}

function broadcast(event, data) {
  for (const res of listeners) sseSend(res, event, data);
}

function broadcastGuild(guildId) {
  const guild = store.computeGuild(guildId);
  if (guild) broadcast('guild', guild);
}

function broadcastGuilds() {
  broadcast('guilds', store.listGuilds());
}

function broadcastChannels(guildId) {
  broadcast('channels', { guildId, channels: store.listChannels(guildId) });
}

// Coalesce bursts of presence/member events into at most one push per guild
// every ~350ms, so a busy server can't flood the browser.
const pendingGuilds = new Set();
let guildFlushTimer = null;
function scheduleGuildBroadcast(guildId) {
  pendingGuilds.add(guildId);
  if (guildFlushTimer) return;
  guildFlushTimer = setTimeout(() => {
    guildFlushTimer = null;
    for (const id of pendingGuilds) broadcastGuild(id);
    pendingGuilds.clear();
    broadcastTotals();
  }, 350);
}

function broadcastTotals() {
  broadcast('totals', store.totals());
}

// -------------------------------------------------------------- client wiring

function shouldTrack(guildId) {
  return GUILD_FILTER.length === 0 || GUILD_FILTER.includes(guildId);
}

function wireClient(c, mode) {
  c.on('state', (s) => {
    const conn = store.setConnection({ state: s.state, error: s.error || null, mode });
    if (s.state === 'error') noteError(s.error || 'gateway reported an error state');
    broadcast('state', conn);
  });

  // The REST identity probe failed at boot; the gateway READY payload will
  // supply the identity instead. Surface it, but do NOT treat it as fatal.
  c.on('identityPending', (info) => {
    console.warn('[dashboard] REST identity probe failed, will use gateway READY:', info.error);
    broadcast('state', {
      ...store.connection,
      error: null,
      notice: 'REST identity check is retrying in the background; gateway data still flows.',
    });
  });

  c.on('user', (u) => {
    store.setBotUser(u);
    broadcast('bot', store.botUser);
  });

  c.on('ready', () => {
    store.setConnection({ state: 'ready', error: null, mode });
    diag.readySince = new Date().toISOString();
    noteError(null);
    broadcast('state', store.connection);
    // Channels/members arrive with GUILD_CREATE; ask for the full member list
    // where the client supports it (needs the privileged GUILD_MEMBERS intent).
    if (mode === 'bot' && typeof c.requestGuildMembers === 'function') {
      for (const id of c.guildIds) {
        c.requestGuildMembers(id, { presences: true }).catch(() => {});
      }
    }
    broadcastGuilds();
  });

  c.on('resumed', () => {
    store.setConnection({ state: 'ready', error: null, mode });
    noteError(null);
    broadcast('state', store.connection);
  });

  c.on('guildCreate', (g) => {
    if (!shouldTrack(g.id)) return;
    if (g.unavailable && store.guilds.has(g.id)) {
      // Partial payload sent during a Discord outage - keep the cached data.
      store.guilds.get(g.id).unavailable = true;
    } else {
      store.ingestGuildCreate(g);
    }
    broadcastGuild(g.id);
    broadcastChannels(g.id);
    broadcastGuilds();
    broadcastTotals();
  });

  c.on('guildUpdate', (g) => {
    if (!shouldTrack(g.id) || g.unavailable) return;
    store.ingestGuildCreate(g);
    broadcastGuild(g.id);
  });

  c.on('guildDelete', (g) => {
    store.removeGuild(g.id, !!g.unavailable);
    broadcastGuilds();
    broadcastTotals();
    if (!g.unavailable) broadcast('guildRemoved', { id: g.id });
  });

  const onChannel = (ch) => {
    if (!shouldTrack(ch.guild_id)) return;
    store.ingestChannel(ch);
    broadcastChannels(ch.guild_id);
    broadcastGuild(ch.guild_id);
  };
  c.on('channelCreate', onChannel);
  c.on('channelUpdate', onChannel);
  c.on('channelDelete', (ch) => {
    store.removeChannel(ch.id);
    broadcastChannels(ch.guild_id);
    broadcastGuild(ch.guild_id);
  });

  c.on('guildMemberAdd', (m) => {
    if (!shouldTrack(m.guild_id)) return;
    store.ingestMemberAdd(m.guild_id, m);
    scheduleGuildBroadcast(m.guild_id);
    broadcast('memberEvent', { guildId: m.guild_id, type: 'add', userId: m.user && m.user.id });
  });

  c.on('guildMemberUpdate', (m) => {
    if (!shouldTrack(m.guild_id)) return;
    store.ingestMemberUpdate(m.guild_id, m);
    scheduleGuildBroadcast(m.guild_id);
  });

  c.on('guildMemberRemove', (m) => {
    if (!shouldTrack(m.guild_id)) return;
    store.ingestMemberRemove(m.guild_id, m.user.id);
    scheduleGuildBroadcast(m.guild_id);
    broadcast('memberEvent', { guildId: m.guild_id, type: 'remove', userId: m.user.id });
  });

  c.on('guildMembersChunk', (chunk) => {
    if (!shouldTrack(chunk.guild_id)) return;
    store.ingestMemberChunk(chunk);
    scheduleGuildBroadcast(chunk.guild_id);
  });

  c.on('presenceUpdate', (p) => {
    if (!shouldTrack(p.guild_id)) return;
    store.ingestPresence(p.guild_id, p);
    scheduleGuildBroadcast(p.guild_id);
  });

  c.on('messageCreate', (m) => {
    const rec = store.ingestMessage(m);
    if (rec) broadcast('message', rec);
  });

  c.on('messageUpdate', (m) => {
    const rec = store.updateMessage(m);
    if (rec) broadcast('messageUpdate', rec);
  });

  c.on('messageDelete', (m) => {
    store.deleteMessage(m.id, m.channel_id);
    broadcast('messageDelete', { id: m.id, channelId: m.channel_id });
  });

  c.on('error', (err) => {
    console.error('[dashboard] client error:', err.message);
    diag.lastError = err.message;
    diag.lastErrorAt = new Date().toISOString();
  });
}

// ------------------------------------------------------------------- HTTP app

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mode: store.connection.mode,
    state: store.connection.state,
    guilds: store.guilds.size,
    listeners: listeners.size,
    uptimeSeconds: Math.round(process.uptime()),
    // --- diagnostics: enough to tell WHY it is not live, without log access ---
    tokenConfigured: diag.tokenConfigured,
    demo: DEMO,
    lastError: diag.lastError,
    lastErrorAt: diag.lastErrorAt,
    readySince: diag.readySince,
  });
});

app.get('/api/diagnostics', (_req, res) => {
  const hints = [];
  if (!diag.tokenConfigured) {
    hints.push(
      'DISCORD_BOT_TOKEN is not set - the dashboard is running the built-in simulator. Set it in your host\'s environment settings.'
    );
  }
  if (diag.lastError && /4004|401/i.test(diag.lastError)) {
    hints.push('The bot token looks invalid or was reset. Paste the current token from the Developer Portal.');
  }
  if (diag.lastError && /intents|4014|4013/i.test(diag.lastError)) {
    hints.push(
      'Privileged intents are disabled. Enable "Server Members" and "Message Content" under Bot > Privileged Gateway Intents.'
    );
  }
  if (diag.tokenConfigured && store.connection.state === 'ready' && store.guilds.size === 0) {
    hints.push('The gateway is connected but the bot is in no servers. Invite it with the URL in README/DEPLOY.');
  }
  if (store.connection.state === 'connecting' && !diag.lastError) {
    hints.push('Gateway handshake in progress - this normally settles within a few seconds.');
  }

  res.json({
    bot: store.botUser,
    connection: store.connection,
    tokenConfigured: diag.tokenConfigured,
    demo: DEMO,
    gatewayAttempts: diag.gatewayAttempts,
    lastError: diag.lastError,
    lastErrorAt: diag.lastErrorAt,
    readySince: diag.readySince,
    uptimeSeconds: Math.round(process.uptime()),
    port: PORT,
    hints,
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    historyLimit: HISTORY_LIMIT,
    maxMessagesPerChannel: MAX_MESSAGES,
    demo: DEMO,
    guildFilter: GUILD_FILTER,
    readOnly: true,
    version: '1.0.1',
  });
});

app.get('/api/snapshot', (_req, res) => {
  const guilds = store.listGuilds();
  const channelsByGuild = {};
  for (const g of guilds) channelsByGuild[g.id] = store.listChannels(g.id);
  res.json({
    bot: store.botUser,
    connection: store.connection,
    serverTime: new Date().toISOString(),
    totals: store.totals(),
    guilds,
    channelsByGuild,
  });
});

app.get('/api/guilds', (_req, res) => {
  res.json({ guilds: store.listGuilds(), totals: store.totals() });
});

app.get('/api/guilds/:guildId', (req, res) => {
  const guild = store.computeGuild(req.params.guildId);
  if (!guild) return res.status(404).json({ error: 'Guild not tracked', guildId: req.params.guildId });
  res.json({ guild, channels: store.listChannels(req.params.guildId) });
});

app.get('/api/guilds/:guildId/channels', (req, res) => {
  if (!store.guilds.has(req.params.guildId)) {
    return res.status(404).json({ error: 'Guild not tracked', guildId: req.params.guildId });
  }
  res.json({ guildId: req.params.guildId, channels: store.listChannels(req.params.guildId) });
});

app.get('/api/channels/:channelId/messages', async (req, res) => {
  const { channelId } = req.params;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || HISTORY_LIMIT));

  if (store.messages.has(channelId) && (store.messages.get(channelId) || []).length >= limit) {
    return res.json({
      channelId,
      source: 'buffer',
      messages: store.listMessages(channelId, limit),
    });
  }

  if (DEMO || !client || !client.rest) {
    return res.json({
      channelId,
      source: 'buffer',
      note: 'Demo mode - synthetic messages only.',
      messages: store.listMessages(channelId, limit),
    });
  }

  try {
    const raw = await client.rest.getChannelMessages(channelId, limit); // newest first
    const ordered = raw.slice().reverse(); // chronological
    for (const m of ordered) store.ingestMessage(m, { silent: true });
    res.json({ channelId, source: 'rest', messages: store.listMessages(channelId, limit) });
  } catch (err) {
    const status = err.status === 429 ? 503 : err.status || 500;
    res.status(status).json({
      error: 'Failed to fetch channel history from Discord',
      detail: err.message,
      hint:
        err.status === 403
          ? 'The bot needs the "Read Message History" permission in this channel.'
          : err.status === 401
            ? 'The bot token is invalid - check DISCORD_BOT_TOKEN.'
            : err.status === 429
              ? 'Discord rate limited the request. It will recover automatically; retry in a moment.'
              : undefined,
    });
  }
});

app.post('/api/guilds/:guildId/sync-members', async (req, res) => {
  if (DEMO || !client || typeof client.requestGuildMembers !== 'function') {
    return res.status(400).json({ error: 'Member sync is only available in bot mode.' });
  }
  const ok = await client.requestGuildMembers(req.params.guildId, { presences: true });
  res.json({ guildId: req.params.guildId, requested: true, completed: ok });
});

// ------------------------------------------------------- live stream (SSE)

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Tell EventSource how fast to retry if the stream drops (Render/proxies can
  // cut a long-lived response; the browser must come back quickly).
  res.write('retry: 3000\n\n');
  res.write(': connected\n\n');

  listeners.add(res);

  // Initial full state so a fresh tab renders instantly.
  const guilds = store.listGuilds();
  const channelsByGuild = {};
  for (const g of guilds) channelsByGuild[g.id] = store.listChannels(g.id);
  sseSend(res, 'init', {
    bot: store.botUser,
    connection: store.connection,
    guilds,
    channelsByGuild,
    totals: store.totals(),
    serverTime: new Date().toISOString(),
  });

  // Keep-alive comment well inside Render's / Cloudflare's idle timeout, so the
  // stream is not silently closed for inactivity.
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* handled by close */
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    listeners.delete(res);
  });
});

// ------------------------------------------------------------------- startup

async function refreshGuildCounts() {
  if (DEMO || !client || !client.rest) return;
  for (const id of store.guilds.keys()) {
    try {
      const g = await client.rest.getGuild(id);
      const cached = store.guilds.get(id);
      if (!cached) continue;
      if (typeof g.approximate_member_count === 'number' && g.approximate_member_count > cached.member_count) {
        cached.member_count = g.approximate_member_count;
      }
      if (typeof g.approximate_presence_count === 'number') {
        cached.presence_count = g.approximate_presence_count;
      }
      if (g.name) cached.name = g.name;
      if (g.icon !== undefined) cached.icon = g.icon;
    } catch {
      /* not fatal - the gateway snapshot remains authoritative */
    }
  }
  broadcastGuilds();
  broadcastTotals();
}

/**
 * Connect to Discord. Never throws, never blocks the HTTP server: any failure
 * is recorded as a diagnostic and retried in the background.
 */
async function startDiscord() {
  if (DEMO) {
    if (!TOKEN) console.log('[dashboard] No DISCORD_BOT_TOKEN set -> starting in DEMO mode.');
    else console.log('[dashboard] DEMO mode forced -> starting the simulator.');
    store.setConnection({ state: 'connecting', mode: 'demo', error: null });
    client = new DemoClient({ debug: DEBUG });
    wireClient(client, 'demo');
    try {
      await client.start();
    } catch (err) {
      noteError(`Demo client failed: ${err.message}`);
      store.setConnection({ state: 'error', mode: 'demo', error: err.message });
    }
    return;
  }

  console.log('[dashboard] Starting in BOT mode.');
  diag.gatewayAttempts++;
  store.setConnection({ state: 'connecting', mode: 'bot', error: null });
  client = new DiscordClient(TOKEN, { debug: DEBUG });
  wireClient(client, 'bot');
  client.on('ready', () => setTimeout(refreshGuildCounts, 2500));

  try {
    // Resolves once the socket is connecting (NOT once READY arrives), so this
    // can never hang the process.
    await client.start();
  } catch (err) {
    noteError(`Failed to start bot: ${err.message}`);
    store.setConnection({ state: 'error', mode: 'bot', error: err.message });
  }
}

/**
 * If the gateway landed in a fatal state (bad token, disabled intents), retry
 * periodically so that fixing the setting on the Discord side - or in the host's
 * env tab - recovers the dashboard WITHOUT a redeploy.
 */
function scheduleFatalRetry() {
  clearTimeout(diag.fatalRetryTimer);
  diag.fatalRetryTimer = setTimeout(async () => {
    if (store.connection.state !== 'error') return;
    console.log('[dashboard] retrying Discord connection after fatal error...');
    if (client && typeof client.destroy === 'function') client.destroy();
    await startDiscord();
    scheduleFatalRetry();
  }, FATAL_RETRY_MS);
  if (diag.fatalRetryTimer.unref) diag.fatalRetryTimer.unref();
}

async function main() {
  // -------------------------------------------------------------------------
  // 1. BIND THE PORT FIRST. This is the whole point: the platform's port and
  //    health check must succeed immediately, regardless of Discord's state.
  // -------------------------------------------------------------------------
  const server = app.listen(PORT, () => {
    console.log(`\n  Discord Live Dashboard v1.0.1`);
    console.log(`  mode      : ${DEMO ? 'DEMO (synthetic live data)' : 'BOT (Discord Gateway)'}`);
    console.log(`  token     : ${diag.tokenConfigured ? 'configured' : 'NOT CONFIGURED'}`);
    console.log(`  port      : ${PORT}`);
    console.log(`  health    : http://localhost:${PORT}/api/health`);
    console.log(`  stream    : http://localhost:${PORT}/api/stream\n`);
  });
  server.on('error', (err) => {
    noteError(`HTTP server error: ${err.message}`);
  });

  // -------------------------------------------------------------------------
  // 2. Only then talk to Discord - in the background.
  // -------------------------------------------------------------------------
  startDiscord().then(scheduleFatalRetry);

  // Periodic recompute so the UI always reflects fresh derived counts.
  setInterval(() => {
    broadcastGuilds();
    broadcastTotals();
  }, 15000);

  if (!DEMO) setInterval(refreshGuildCounts, REFRESH_MS);
}

function shutdown() {
  console.log('\n[dashboard] shutting down...');
  if (client && typeof client.destroy === 'function') client.destroy();
  for (const res of listeners) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// A rejected promise anywhere must not silently take the dashboard down with a
// closed port; log it and keep serving (the process is a long-running service).
process.on('unhandledRejection', (reason) => {
  console.error('[dashboard] unhandled rejection:', reason && reason.message ? reason.message : reason);
});

main().catch((err) => {
  console.error('[dashboard] fatal:', err);
  process.exit(1);
});
