'use strict';

/**
 * End-to-end check of the live pipeline.
 *
 *   node test/realtime-check.js [baseUrl]
 *
 * Verifies that:
 *   1. /api/snapshot returns servers with live counts and channels per server.
 *   2. /api/stream holds a real SSE connection.
 *   3. At least one count actually CHANGES while we listen (the core claim:
 *      "live/real-time updating, not a static snapshot").
 *   4. MESSAGE_CREATE events stream in.
 *
 * Exits non-zero if any assertion fails, so it doubles as a CI smoke test.
 */

const BASE = process.argv[2] || 'http://localhost:3000';
const LISTEN_MS = Number(process.env.LISTEN_MS || 15000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error('  ✗ ' + msg);
  process.exitCode = 1;
}
function pass(msg) {
  console.log('  ✓ ' + msg);
}

async function getJson(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`\nDiscord Live Dashboard - realtime check against ${BASE}\n`);

  // ---------------------------------------------------------------- snapshot
  const snap = await getJson('/api/snapshot');
  const guilds = snap.guilds || [];
  console.log(`[1] snapshot: mode=${snap.connection.mode} state=${snap.connection.state} guilds=${guilds.length}`);
  if (!guilds.length) fail('no guilds in snapshot');
  else pass(`${guilds.length} servers returned`);

  let channelTotal = 0;
  let textTotal = 0;
  for (const g of guilds) {
    const chans = (snap.channelsByGuild || {})[g.id] || [];
    channelTotal += chans.length;
    textTotal += chans.filter((c) => c.is_text).length;
    const ok = ['memberCount', 'onlineCount', 'offlineCount'].every((k) => typeof g[k] === 'number');
    if (!ok) fail(`${g.name}: missing numeric counts`);
    // Every channel must belong to exactly this guild.
    const stray = chans.filter((c) => c.guild_id !== g.id);
    if (stray.length) fail(`${g.name}: ${stray.length} channel(s) attributed to the wrong guild`);
    // The reported text-channel count must match the channels actually listed.
    const actualText = chans.filter((c) => c.is_text).length;
    if (g.textChannelCount !== actualText) {
      fail(`${g.name}: textChannelCount=${g.textChannelCount} but ${actualText} text channels listed`);
    }
    // Counts must be self-consistent.
    if (g.offlineCount + g.onlineCount !== g.memberCount) {
      fail(`${g.name}: online+offline=${g.onlineCount + g.offlineCount} != members=${g.memberCount}`);
    }
  }
  pass(`${channelTotal} channels total (${textTotal} text), correctly grouped by server`);

  if (new Set(guilds.map((g) => g.id)).size !== guilds.length) fail('duplicate guild ids');

  // ------------------------------------------------------------------- stream
  const controller = new AbortController();
  const res = await fetch(BASE + '/api/stream', {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!res.ok) throw new Error('/api/stream -> HTTP ' + res.status);
  if (!String(res.headers.get('content-type')).includes('text/event-stream')) {
    fail('stream content-type is not text/event-stream');
  } else {
    pass('SSE stream open (content-type text/event-stream)');
  }

  const counts = new Map();
  const events = new Map();
  let messages = 0;
  let guildUpdates = 0;
  let firstMessage = null;
  const changed = new Map();

  (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop();
      for (const block of blocks) {
        let ev = null;
        let data = null;
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) ev = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (!ev || data === null) continue;
        events.set(ev, (events.get(ev) || 0) + 1);

        let payload = null;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }

        if (ev === 'init' || ev === 'guilds') {
          const list = ev === 'init' ? payload.guilds : payload;
          for (const g of list || []) counts.set(g.id, `${g.memberCount}/${g.onlineCount}/${g.offlineCount}`);
        } else if (ev === 'guild') {
          guildUpdates++;
          const prev = counts.get(payload.id);
          const now = `${payload.memberCount}/${payload.onlineCount}/${payload.offlineCount}`;
          if (prev && prev !== now) changed.set(payload.id, `${prev}  ->  ${now}`);
          counts.set(payload.id, now);
        } else if (ev === 'message') {
          messages++;
          if (!firstMessage) firstMessage = payload;
        }
      }
    }
  })();

  console.log(`\n[2] listening for ${LISTEN_MS / 1000}s of live events...`);
  await sleep(LISTEN_MS);
  controller.abort();
  await sleep(150);

  console.log(`[3] event tally: ${JSON.stringify(Object.fromEntries(events))}`);

  if (guildUpdates > 0) pass(`${guildUpdates} guild count updates pushed over SSE`);
  else fail('no guild count updates received');

  if (changed.size > 0) {
    pass(`counts changed LIVE on ${changed.size} server(s), e.g. ${changed.get([...changed.keys()][0])}`);
  } else {
    fail('no server count ever changed - the dashboard would look static');
  }

  if (messages > 0) {
    const who = firstMessage.author.global_name || firstMessage.author.username;
    pass(`${messages} live message(s) streamed, e.g. ${who}: "${String(firstMessage.content).slice(0, 48)}"`);
  } else {
    fail('no live messages received');
  }

  console.log(process.exitCode ? '\nRESULT: FAILED\n' : '\nRESULT: PASSED\n');
}

main().catch((err) => {
  console.error('realtime check crashed:', err.message);
  process.exit(1);
});
