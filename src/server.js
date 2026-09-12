'use strict';

/**
 * Discord Live Dashboard - HTTP server.
 *
 * Pipeline:  Discord Gateway (WebSocket) -> DiscordClient events -> Store
 *            -> SSE broadcast -> browser dashboard.
 *
 * In demo mode a synthetic client emits the same events, so the live path can
 * be verified without a bot token.
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const { Store } = require('./state');
const { DiscordClient } = require('./discord');
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

const store = new Store({ maxMessages: MAX_MESSAGES });
const listeners = new Set();
let client = null;

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
    broadcast('state', conn);
  });

  c.on('user', (u) => {
    store.setBotUser(u);
    broadcast('bot', store.botUser);
  });

  c.on('ready', () => {
    store.setConnection({ state: 'ready', error: null, mode });
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
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    historyLimit: HISTORY_LIMIT,
    maxMessagesPerChannel: MAX_MESSAGES,
    demo: DEMO,
    guildFilter: GUILD_FILTER,
    readOnly: true,
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
    res.status(err.status || 500).json({
      error: 'Failed to fetch channel history from Discord',
      detail: err.message,
      hint:
        err.status === 403
          ? 'The bot needs the "Read Message History" permission in this channel.'
          : err.status === 401
            ? 'The bot token is invalid.'
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

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* handled by close */
    }
  }, 20000);

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

async function main() {
  if (DEMO) {
    if (!TOKEN) console.log('[dashboard] No DISCORD_BOT_TOKEN set -> starting in DEMO mode.');
    else console.log('[dashboard] DEMO mode forced -> starting the simulator.');
    store.setConnection({ state: 'connecting', mode: 'demo', error: null });
    client = new DemoClient({ debug: DEBUG });
    wireClient(client, 'demo');
    await client.start();
  } else {
    console.log('[dashboard] Starting in BOT mode.');
    store.setConnection({ state: 'connecting', mode: 'bot', error: null });
    client = new DiscordClient(TOKEN, { debug: DEBUG });
    wireClient(client, 'bot');
    client.on('ready', () => {
      setTimeout(refreshGuildCounts, 2500);
    });
    try {
      await client.start();
    } catch (err) {
      console.error('[dashboard] Failed to start bot:', err.message);
      store.setConnection({ state: 'error', mode: 'bot', error: err.message });
    }
  }

  // Periodic recompute so the UI always reflects fresh derived counts.
  setInterval(() => {
    broadcastGuilds();
    broadcastTotals();
  }, 15000);

  if (!DEMO) setInterval(refreshGuildCounts, REFRESH_MS);

  app.listen(PORT, () => {
    console.log(`\n  Discord Live Dashboard`);
    console.log(`  mode      : ${DEMO ? 'DEMO (synthetic live data)' : 'BOT (Discord Gateway)'}`);
    console.log(`  dashboard : http://localhost:${PORT}`);
    console.log(`  stream    : http://localhost:${PORT}/api/stream`);
    console.log(`  health    : http://localhost:${PORT}/api/health\n`);
  });
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

main().catch((err) => {
  console.error('[dashboard] fatal:', err);
  process.exit(1);
});
