'use strict';

/**
 * Dashboard front-end.
 *
 * Receives a full snapshot on connect (`init`) and then incremental events over
 * SSE: guild count updates, channel updates, and message create/update/delete.
 * Every count rendered here is reactive - it changes when Discord says so.
 */

const state = {
  guilds: new Map(),
  channelsByGuild: new Map(),
  messages: new Map(),
  selectedGuildId: null,
  selectedChannelId: null,
  connection: { state: 'connecting' },
  bot: null,
  totals: null,
  historyLimit: 100,
  demo: false,
};

const $ = (id) => document.getElementById(id);

// ----------------------------------------------------------------- utilities

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function avatarColor(id) {
  let hash = 0;
  for (let i = 0; i < String(id).length; i++) hash = (hash * 31 + String(id).charCodeAt(i)) % 360;
  return `hsl(${hash}, 52%, 44%)`;
}

function initials(name) {
  const clean = String(name || '?').replace(/[^\w]/g, '');
  return (clean.slice(0, 2) || '?').toUpperCase();
}

function avatarUrl(id, hash, size = 64) {
  if (!id || !hash) return null;
  const ext = String(hash).startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}?size=${size}`;
}

function iconUrl(guildId, iconHash, size = 64) {
  if (!guildId || !iconHash) return null;
  const ext = String(iconHash).startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.${ext}?size=${size}`;
}

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function clockTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmt(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

function bump(el) {
  if (!el) return;
  el.classList.remove('bump');
  void el.offsetWidth; // restart the animation
  el.classList.add('bump');
}

// -------------------------------------------------------------- server list

function renderServers() {
  const container = $('serverList');
  const guilds = [...state.guilds.values()].sort((a, b) => b.memberCount - a.memberCount);
  $('guildCount').textContent = String(guilds.length);

  if (!guilds.length) {
    container.innerHTML = `<div class="empty">${
      state.connection.state === 'ready'
        ? 'The bot has not joined any servers yet.'
        : 'Waiting for gateway data…'
    }</div>`;
    return;
  }

  container.innerHTML = guilds
    .map((g) => {
      const active = g.id === state.selectedGuildId ? ' active' : '';
      const icon = iconUrl(g.id, g.icon);
      const iconHtml = icon
        ? `<img src="${icon}" alt="" onerror="this.replaceWith(document.createTextNode('${escapeHtml(initials(g.name))}'))" />`
        : escapeHtml(initials(g.name));
      return `
        <button class="server${active}" data-guild="${g.id}">
          <div class="server-top">
            <div class="guild-icon">${iconHtml}</div>
            <div>
              <div class="server-name">${escapeHtml(g.name)}</div>
              <div class="server-sub">${g.textChannelCount} text channel${g.textChannelCount === 1 ? '' : 's'}${
        g.unavailable ? ' · unavailable' : ''
      }</div>
            </div>
          </div>
          <div class="server-metrics">
            <div class="metric"><span>Members</span><b data-count="member-${g.id}">${fmt(g.memberCount)}</b></div>
            <div class="metric"><span>Online</span><b data-count="online-${g.id}">${fmt(g.onlineCount)}</b></div>
            <div class="metric"><span>Offline</span><b data-count="offline-${g.id}">${fmt(g.offlineCount)}</b></div>
            <div class="metric"><span>Bots</span><b data-count="bots-${g.id}">${fmt(g.botCount)}</b></div>
          </div>
        </button>`;
    })
    .join('');

  container.querySelectorAll('.server').forEach((btn) => {
    btn.addEventListener('click', () => selectGuild(btn.dataset.guild));
  });
}

function updateServerCounts(guild) {
  const pairs = [
    ['member', guild.memberCount],
    ['online', guild.onlineCount],
    ['offline', guild.offlineCount],
    ['bots', guild.botCount],
  ];
  for (const [key, value] of pairs) {
    const selector = `[data-count="${key}-${guild.id}"]`;
    const el = document.querySelector(selector);
    if (!el) continue;
    const next = fmt(value);
    if (el.textContent !== next) {
      el.textContent = next;
      bump(el);
    }
  }
}

// ------------------------------------------------------------------- stats

function renderStats() {
  const g = state.guilds.get(state.selectedGuildId);
  const box = $('stats');
  if (!g) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `
    <div class="stat"><label>Total members</label><strong id="statMembers">${fmt(g.memberCount)}</strong></div>
    <div class="stat online"><label>Online</label><strong id="statOnline">${fmt(g.onlineCount)}</strong></div>
    <div class="stat offline"><label>Offline</label><strong id="statOffline">${fmt(g.offlineCount)}</strong></div>
    <div class="stat bots"><label>Bots</label><strong id="statBots">${fmt(g.botCount)}</strong>${
    g.botCount == null ? '<div class="muted small" style="margin-top:4px">needs Guild Members intent</div>' : ''
  }</div>`;

  const b = g.presenceBreakdown || {};
  $('chatSubtitle').textContent =
    `online ${fmt(b.online)} · idle ${fmt(b.idle)} · dnd ${fmt(b.dnd)}` + (state.demo ? ' · demo data' : '');
}

function updateStats(guild) {
  if (guild.id !== state.selectedGuildId) return;
  const fields = [
    ['statMembers', guild.memberCount],
    ['statOnline', guild.onlineCount],
    ['statOffline', guild.offlineCount],
    ['statBots', guild.botCount],
  ];
  for (const [id, value] of fields) {
    const el = $(id);
    if (!el) continue;
    const next = fmt(value);
    if (el.textContent !== next) {
      el.textContent = next;
      bump(el);
    }
  }
  const b = guild.presenceBreakdown || {};
  const sub = `online ${fmt(b.online)} · idle ${fmt(b.idle)} · dnd ${fmt(b.dnd)}` + (state.demo ? ' · demo data' : '');
  if ($('chatSubtitle') && state.selectedChannelId) $('chatSubtitle').textContent = sub;
}

// ---------------------------------------------------------------- channels

function renderChannels() {
  const container = $('channelList');
  const guild = state.guilds.get(state.selectedGuildId);
  const channels = state.channelsByGuild.get(state.selectedGuildId) || [];

  $('guildTitle').textContent = guild ? guild.name : 'No server selected';
  $('syncBtn').disabled = !guild || state.demo;

  if (!guild) {
    container.innerHTML = '<div class="empty">Select a server to see its channels.</div>';
    return;
  }

  const text = channels.filter((c) => c.is_text);
  const other = channels.filter((c) => !c.is_text);

  if (!channels.length) {
    container.innerHTML = '<div class="empty">No channels reported for this server yet.</div>';
    return;
  }

  const channelHtml = (c, voiced) => {
    const active = c.id === state.selectedChannelId ? ' active' : '';
    return `
      <button class="channel${voiced ? ' voiced' : ''}${active}" data-channel="${c.id}">
        <span class="hash">${voiced ? '⌗' : '#'}</span>
        <span class="cname">${escapeHtml(c.name || 'unnamed')}</span>
        ${c.bufferedMessages ? `<span class="badge">${c.bufferedMessages}</span>` : ''}
        ${c.is_text ? '' : ''}
      </button>`;
  };

  container.innerHTML =
    `<div class="group-label">Text channels · ${text.length}</div>` +
    (text.length ? text.map((c) => channelHtml(c, false)).join('') : '<div class="empty">None</div>') +
    `<div class="group-label">Other channels · ${other.length}</div>` +
    (other.length ? other.map((c) => channelHtml(c, true)).join('') : '<div class="empty">None</div>');

  container.querySelectorAll('.channel').forEach((btn) => {
    const channel = channels.find((c) => c.id === btn.dataset.channel);
    if (channel && !channel.is_text) {
      btn.addEventListener('click', () => {
        $('messages').innerHTML =
          '<div class="empty">That channel is not a text channel — pick one under “Text channels”.</div>';
      });
      return;
    }
    btn.addEventListener('click', () => selectChannel(btn.dataset.channel));
  });
}

// -------------------------------------------------------------------- chat

function messageHtml(m, fresh) {
  const url = avatarUrl(m.author.id, m.author.avatar);
  const avatar = url
    ? `<div class="avatar"><img src="${url}" alt="" loading="lazy" /></div>`
    : `<div class="avatar" style="background:${avatarColor(m.author.id)}">${escapeHtml(initials(m.author.username))}</div>`;

  const name = m.author.global_name || m.author.username;
  const attachments = (m.attachments || [])
    .map((a) => `<a class="msg-attach" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">📎 ${escapeHtml(a.filename)}</a>`)
    .join('');

  const content = m.content
    ? `<div class="msg-content">${escapeHtml(m.content)}</div>`
    : (m.attachments || []).length
      ? '<div class="msg-content muted">(attachment)</div>'
      : m.embedCount
        ? '<div class="msg-content muted">(embed)</div>'
        : '';

  return `
    <div class="msg${fresh ? ' fresh' : ''}" data-msg="${m.id}">
      ${avatar}
      <div class="msg-body">
        <div class="msg-meta">
          <span class="msg-author" style="color:${avatarColor(m.author.id)}">${escapeHtml(name)}</span>
          ${m.author.bot ? '<span class="tag">BOT</span>' : ''}
          ${m.edited_timestamp ? '<span class="tag edited">EDITED</span>' : ''}
          <span class="msg-time" title="${escapeHtml(m.timestamp)}">${clockTime(m.timestamp)}</span>
        </div>
        ${content}
        ${attachments ? `<div>${attachments}</div>` : ''}
      </div>
    </div>`;
}

function renderMessages() {
  const box = $('messages');
  const list = state.messages.get(state.selectedChannelId) || [];
  const guild = state.guilds.get(state.selectedGuildId);
  const channel = (state.channelsByGuild.get(state.selectedGuildId) || []).find(
    (c) => c.id === state.selectedChannelId
  );

  if (channel) {
    $('chatTitle').textContent = `#${channel.name}`;
    if (guild && !state.selectedChannelId) $('chatSubtitle').textContent = guild.name;
  } else {
    $('chatTitle').textContent = 'Live chat';
  }

  if (!list.length) {
    box.innerHTML = `<div class="empty">No messages buffered for this channel yet.<br />New messages will appear here the moment they are posted.</div>`;
    return;
  }
  box.innerHTML = list.map((m) => messageHtml(m, false)).join('');
  box.scrollTop = box.scrollHeight;
}

function appendMessage(m) {
  const arr = state.messages.get(m.channel_id) || [];
  if (arr.some((x) => x.id === m.id)) return;
  arr.push(m);
  if (arr.length > 300) arr.splice(0, arr.length - 300);
  state.messages.set(m.channel_id, arr);

  // Keep the channel badge fresh.
  const guildChannels = state.channelsByGuild.get(m.guild_id);
  if (guildChannels) {
    const ch = guildChannels.find((c) => c.id === m.channel_id);
    if (ch) ch.bufferedMessages = arr.length;
  }

  if (m.channel_id !== state.selectedChannelId) {
    const el = document.querySelector(`[data-channel="${m.channel_id}"] .badge`);
    if (el) el.textContent = arr.length;
    return;
  }

  const box = $('messages');
  if (!box.querySelector('.msg')) box.innerHTML = '';
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = messageHtml(m, true).trim();
  const node = wrapper.firstElementChild;
  box.appendChild(node);

  while (box.children.length > 300) box.removeChild(box.firstChild);
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function replaceMessage(m) {
  const arr = state.messages.get(m.channel_id) || [];
  const idx = arr.findIndex((x) => x.id === m.id);
  if (idx === -1) return;
  arr[idx] = m;
  if (m.channel_id !== state.selectedChannelId) return;
  const node = document.querySelector(`[data-msg="${m.id}"]`);
  if (node) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = messageHtml(m, false).trim();
    node.replaceWith(wrapper.firstElementChild);
  }
}

function removeMessage(id, channelId) {
  const arr = state.messages.get(channelId) || [];
  const idx = arr.findIndex((x) => x.id === id);
  if (idx !== -1) arr.splice(idx, 1);
  if (channelId !== state.selectedChannelId) return;
  const node = document.querySelector(`[data-msg="${id}"]`);
  if (node) node.remove();
}

// -------------------------------------------------------------- selections

async function selectGuild(guildId) {
  state.selectedGuildId = guildId;
  $('selectedGuild').value = guildId;
  renderServers();
  renderStats();

  let channels = state.channelsByGuild.get(guildId);
  if (!channels) {
    try {
      const res = await fetch(`/api/guilds/${guildId}/channels`);
      const json = await res.json();
      channels = json.channels || [];
      state.channelsByGuild.set(guildId, channels);
    } catch {
      channels = [];
    }
  }
  renderChannels();

  const firstText = (channels || []).find((c) => c.is_text);
  if (firstText) selectChannel(firstText.id);
}

async function selectChannel(channelId) {
  state.selectedChannelId = channelId;
  $('selectedChannel').value = channelId;
  renderChannels();

  if (!state.messages.has(channelId)) {
    $('messages').innerHTML = '<div class="empty">Loading history…</div>';
    try {
      const res = await fetch(`/api/channels/${channelId}/messages?limit=${state.historyLimit}`);
      const json = await res.json();
      state.messages.set(channelId, json.messages || []);
      if (json.source === 'buffer' && (json.messages || []).length === 0) {
        state.messages.set(channelId, []);
      }
    } catch {
      state.messages.set(channelId, []);
    }
  }
  renderMessages();
}

// --------------------------------------------------------------- top bar

function renderTotals() {
  const t = state.totals;
  if (!t) return;
  $('totals').innerHTML = `
    <div class="total-item"><b>${fmt(t.guilds)}</b><span>servers</span></div>
    <div class="total-item"><b>${fmt(t.members)}</b><span>members</span></div>
    <div class="total-item"><b>${fmt(t.online)}</b><span>online</span></div>
    <div class="total-item"><b>${fmt(t.bots)}</b><span>bots</span></div>`;
}

function renderConnection() {
  const conn = state.connection || {};
  const el = $('conn');
  el.dataset.state = conn.state || 'connecting';
  const label =
    conn.state === 'ready'
      ? `live${conn.mode === 'demo' ? ' (demo)' : ''}`
      : conn.state === 'error'
        ? 'error'
        : 'connecting…';
  $('connText').textContent = label;
  if (conn.error) $('connText').title = conn.error;

  const bot = state.bot;
  $('botLine').textContent = bot
    ? `${bot.global_name || bot.username}${bot.bot ? ' · bot account' : ''}`
    : conn.mode === 'demo'
      ? 'demo simulator'
      : 'connecting…';
}

// ------------------------------------------------------------------- SSE

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('init', (e) => {
    const d = JSON.parse(e.data);
    state.bot = d.bot;
    state.connection = d.connection || { state: 'connecting' };
    state.totals = d.totals;
    state.guilds = new Map((d.guilds || []).map((g) => [g.id, g]));
    state.channelsByGuild = new Map(Object.entries(d.channelsByGuild || {}));
    state.demo = (d.connection && d.connection.mode === 'demo') || d.demo || false;

    renderConnection();
    renderTotals();
    renderServers();
    if (!state.selectedGuildId) {
      const first = (d.guilds || [])[0];
      if (first) selectGuild(first.id);
    } else {
      renderStats();
      renderChannels();
    }
  });

  es.addEventListener('state', (e) => {
    state.connection = JSON.parse(e.data);
    renderConnection();
  });

  es.addEventListener('bot', (e) => {
    state.bot = JSON.parse(e.data);
    renderConnection();
  });

  es.addEventListener('guilds', (e) => {
    const list = JSON.parse(e.data);
    for (const g of list) {
      state.guilds.set(g.id, g);
      updateServerCounts(g);
      updateStats(g);
    }
    renderServers(); // membership in the list can change
    renderTotals();
  });

  es.addEventListener('guild', (e) => {
    const g = JSON.parse(e.data);
    state.guilds.set(g.id, g);
    updateServerCounts(g);
    updateStats(g);
    if (g.id === state.selectedGuildId) renderStats();
  });

  es.addEventListener('channels', (e) => {
    const { guildId, channels } = JSON.parse(e.data);
    state.channelsByGuild.set(guildId, channels);
    if (guildId === state.selectedGuildId) renderChannels();
  });

  es.addEventListener('totals', (e) => {
    state.totals = JSON.parse(e.data);
    renderTotals();
  });

  es.addEventListener('message', (e) => appendMessage(JSON.parse(e.data)));
  es.addEventListener('messageUpdate', (e) => replaceMessage(JSON.parse(e.data)));
  es.addEventListener('messageDelete', (e) => {
    const d = JSON.parse(e.data);
    removeMessage(d.id, d.channelId);
  });

  es.addEventListener('guildRemoved', (e) => {
    const { id } = JSON.parse(e.data);
    state.guilds.delete(id);
    state.channelsByGuild.delete(id);
    if (state.selectedGuildId === id) {
      state.selectedGuildId = null;
      $('stats').innerHTML = '';
      $('messages').innerHTML = '<div class="empty">Server removed.</div>';
      renderChannels();
    }
    renderServers();
  });

  es.onerror = () => {
    state.connection = { ...(state.connection || {}), state: 'connecting' };
    renderConnection();
    // EventSource reconnects on its own; `init` will re-sync the full state.
  };

  return es;
}

// ------------------------------------------------------------------ boot

async function boot() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    state.historyLimit = cfg.historyLimit || 100;
    state.demo = !!cfg.demo;
  } catch {
    /* defaults are fine */
  }

  $('syncBtn').addEventListener('click', async () => {
    if (!state.selectedGuildId) return;
    const btn = $('syncBtn');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      await fetch(`/api/guilds/${state.selectedGuildId}/sync-members`, { method: 'POST' });
    } catch {
      /* ignore */
    }
    btn.textContent = 'Sync members';
    btn.disabled = false;
  });

  connectStream();

  setInterval(() => {
    $('clock').textContent = new Date().toLocaleTimeString();
  }, 1000);
  $('clock').textContent = new Date().toLocaleTimeString();

  // Relative timestamps stay honest without re-rendering everything.
  setInterval(() => {
    document.querySelectorAll('.msg-time[title]').forEach((el) => {
      const abs = el.getAttribute('title');
      if (abs) el.textContent = clockTime(abs);
    });
  }, 60000);
}

boot();
