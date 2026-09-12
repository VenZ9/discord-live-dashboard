'use strict';

/**
 * In-memory state store.
 *
 * Everything the dashboard shows is derived from Discord Gateway events that
 * are fed into the `ingest*` methods below.  Nothing is persisted - the store
 * is a live projection of the bot's view of Discord.
 */

/** Channel types that can carry readable message history. */
const TEXT_CHANNEL_TYPES = new Set([0, 5]); // GUILD_TEXT, GUILD_ANNOUNCEMENT

/** Discord never sends a presence for a truly offline user, but it does send
 *  a PRESENCE_UPDATE with status "offline" when somebody disconnects. */
const ONLINE_STATUSES = new Set(['online', 'idle', 'dnd']);

class Store {
  constructor(options = {}) {
    this.maxMessages = options.maxMessages || 200;
    this.reset();
  }

  reset() {
    /** guildId -> guild record */
    this.guilds = new Map();
    /** channelId -> channel record (all guilds, flat index) */
    this.channels = new Map();
    /** guildId -> Map(userId -> presence) */
    this.presences = new Map();
    /** guildId -> Map(userId -> member) */
    this.members = new Map();
    /** channelId -> array of message records (chronological) */
    this.messages = new Map();

    this.botUser = null;
    this.connection = {
      state: 'offline', // offline | connecting | ready | error
      mode: 'offline',  // bot | demo | offline
      since: Date.now(),
      error: null,
      guildCount: 0,
    };
    this.counters = { gatewayEvents: 0, messages: 0, presenceUpdates: 0, memberEvents: 0 };
  }

  setConnection(patch) {
    this.connection = { ...this.connection, ...patch, since: Date.now() };
    return this.connection;
  }

  setBotUser(user) {
    this.botUser = user
      ? {
          id: user.id,
          username: user.username,
          global_name: user.global_name || null,
          discriminator: user.discriminator || null,
          avatar: user.avatar || null,
          bot: !!user.bot,
        }
      : null;
  }

  // ---------------------------------------------------------------- guilds

  ingestGuildCreate(g) {
    const prev = this.guilds.get(g.id) || {};
    const guild = {
      id: g.id,
      name: g.name != null ? g.name : prev.name || 'Unknown server',
      icon: g.icon !== undefined ? g.icon : prev.icon || null,
      owner_id: g.owner_id !== undefined ? g.owner_id : prev.owner_id || null,
      features: g.features || prev.features || [],
      member_count:
        typeof g.member_count === 'number' ? g.member_count : prev.member_count || 0,
      presence_count:
        typeof g.presence_count === 'number' ? g.presence_count : prev.presence_count ?? null,
      unavailable: !!g.unavailable,
      joined_at: prev.joined_at || new Date().toISOString(),
    };
    this.guilds.set(guild.id, guild);

    if (Array.isArray(g.channels)) {
      for (const ch of g.channels) this.ingestChannel(ch, guild.id);
    }

    if (Array.isArray(g.members)) {
      const incoming = new Map();
      for (const m of g.members) {
        if (m && m.user && m.user.id) incoming.set(m.user.id, m);
      }
      const existing = this.members.get(guild.id);
      if (existing) {
        for (const [id, m] of existing) if (!incoming.has(id)) incoming.set(id, m);
      }
      this.members.set(guild.id, incoming);
      if (incoming.size > guild.member_count) guild.member_count = incoming.size;
    }

    if (Array.isArray(g.presences)) {
      for (const p of g.presences) this.ingestPresence(guild.id, p, true);
    }

    this.connection.guildCount = this.guilds.size;
    return guild;
  }

  removeGuild(guildId, unavailable) {
    if (unavailable) {
      const g = this.guilds.get(guildId);
      if (g) g.unavailable = true;
      return;
    }
    this.guilds.delete(guildId);
    this.presences.delete(guildId);
    this.members.delete(guildId);
    for (const [id, ch] of this.channels) if (ch.guild_id === guildId) this.channels.delete(id);
    this.connection.guildCount = this.guilds.size;
  }

  // -------------------------------------------------------------- channels

  ingestChannel(ch, guildIdHint) {
    const guildId = ch.guild_id || guildIdHint;
    if (!guildId) return null;
    const record = {
      id: ch.id,
      guild_id: guildId,
      name: ch.name != null ? ch.name : null,
      type: ch.type,
      position: typeof ch.position === 'number' ? ch.position : 0,
      parent_id: ch.parent_id || null,
      topic: ch.topic || null,
      nsfw: !!ch.nsfw,
      is_text: TEXT_CHANNEL_TYPES.has(ch.type),
    };
    this.channels.set(ch.id, record);
    return record;
  }

  removeChannel(channelId) {
    const ch = this.channels.get(channelId);
    this.channels.delete(channelId);
    this.messages.delete(channelId);
    return ch || null;
  }

  // --------------------------------------------------------------- members

  ingestMemberAdd(guildId, member) {
    if (!member || !member.user || !member.user.id) return;
    let map = this.members.get(guildId);
    if (!map) {
      map = new Map();
      this.members.set(guildId, map);
    }
    const isNew = !map.has(member.user.id);
    map.set(member.user.id, member);
    if (isNew) {
      const g = this.guilds.get(guildId);
      if (g) g.member_count = Math.max(g.member_count || 0, map.size);
      this.counters.memberEvents++;
    }
  }

  ingestMemberUpdate(guildId, member) {
    this.ingestMemberAdd(guildId, member);
  }

  ingestMemberRemove(guildId, userId) {
    const map = this.members.get(guildId);
    if (map && map.delete(userId)) {
      const g = this.guilds.get(guildId);
      if (g) g.member_count = Math.max(0, (g.member_count || map.size) - 1);
      this.counters.memberEvents++;
    }
    const pres = this.presences.get(guildId);
    if (pres) pres.delete(userId);
  }

  /** GUILD_MEMBERS_CHUNK - Discord streams large member lists in chunks. */
  ingestMemberChunk(chunk) {
    if (!chunk || !chunk.guild_id) return;
    let map = this.members.get(chunk.guild_id);
    if (!map) {
      map = new Map();
      this.members.set(chunk.guild_id, map);
    }
    for (const m of chunk.members || []) {
      if (m && m.user && m.user.id) map.set(m.user.id, m);
    }
    for (const p of chunk.presences || []) this.ingestPresence(chunk.guild_id, p, true);
    const g = this.guilds.get(chunk.guild_id);
    if (g) g.member_count = Math.max(g.member_count || 0, map.size);
  }

  // ------------------------------------------------------------- presences

  ingestPresence(guildId, presence, silent) {
    if (!presence || !presence.user || !presence.user.id) return;
    let map = this.presences.get(guildId);
    if (!map) {
      map = new Map();
      this.presences.set(guildId, map);
    }
    map.set(presence.user.id, {
      user_id: presence.user.id,
      status: presence.status || 'offline',
      activities: presence.activities || [],
      client_status: presence.client_status || {},
    });
    if (!silent) this.counters.presenceUpdates++;
  }

  // -------------------------------------------------------------- messages

  ingestMessage(msg, options = {}) {
    if (!msg || !msg.channel_id || !msg.id) return null;
    const channel = this.channels.get(msg.channel_id);
    const record = {
      id: msg.id,
      channel_id: msg.channel_id,
      guild_id: (channel && channel.guild_id) || msg.guild_id || null,
      channel_name: channel ? channel.name : null,
      author: {
        id: msg.author && msg.author.id,
        username: (msg.author && msg.author.username) || 'unknown',
        global_name: (msg.author && msg.author.global_name) || null,
        bot: !!(msg.author && msg.author.bot),
        avatar: (msg.author && msg.author.avatar) || null,
      },
      content: typeof msg.content === 'string' ? msg.content : '',
      timestamp: msg.timestamp || new Date().toISOString(),
      edited_timestamp: msg.edited_timestamp || null,
      attachments: (msg.attachments || []).map((a) => ({
        id: a.id,
        filename: a.filename,
        url: a.url,
        content_type: a.content_type || null,
        size: a.size || 0,
      })),
      embedCount: (msg.embeds || []).length,
      stickerCount: (msg.sticker_items || []).length,
      mentions: (msg.mentions || []).map((u) => ({ id: u.id, username: u.username })),
      type: msg.type != null ? msg.type : 0,
    };

    let arr = this.messages.get(msg.channel_id);
    if (!arr) {
      arr = [];
      this.messages.set(msg.channel_id, arr);
    }
    // De-duplicate: history backfill and live events can overlap.
    const idx = arr.findIndex((m) => m.id === record.id);
    if (idx !== -1) arr[idx] = record;
    else arr.push(record);

    if (arr.length > this.maxMessages) arr.splice(0, arr.length - this.maxMessages);
    if (!options.silent) this.counters.messages++;
    return record;
  }

  updateMessage(msg) {
    const arr = this.messages.get(msg.channel_id);
    if (!arr) return null;
    const idx = arr.findIndex((m) => m.id === msg.id);
    if (idx === -1) return null;
    if (typeof msg.content === 'string') arr[idx].content = msg.content;
    arr[idx].edited_timestamp = msg.edited_timestamp || new Date().toISOString();
    return arr[idx];
  }

  deleteMessage(messageId, channelId) {
    const arr = this.messages.get(channelId);
    if (!arr) return;
    const idx = arr.findIndex((m) => m.id === messageId);
    if (idx !== -1) arr.splice(idx, 1);
  }

  listMessages(channelId, limit) {
    const arr = this.messages.get(channelId) || [];
    const n = Math.max(1, limit || 100);
    return arr.slice(Math.max(0, arr.length - n));
  }

  // ------------------------------------------------------------ projections

  listChannels(guildId) {
    const out = [];
    for (const ch of this.channels.values()) {
      if (ch.guild_id !== guildId) continue;
      out.push({
        id: ch.id,
        guild_id: ch.guild_id,
        name: ch.name,
        type: ch.type,
        position: ch.position,
        parent_id: ch.parent_id,
        topic: ch.topic,
        is_text: ch.is_text,
        bufferedMessages: (this.messages.get(ch.id) || []).length,
      });
    }
    return out.sort(
      (a, b) => a.position - b.position || String(a.name || '').localeCompare(String(b.name || ''))
    );
  }

  computeGuild(guildId) {
    const g = this.guilds.get(guildId);
    if (!g) return null;

    const pres = this.presences.get(guildId);
    let online = 0;
    let idle = 0;
    let dnd = 0;
    let offlinePresence = 0;
    if (pres) {
      for (const p of pres.values()) {
        if (p.status === 'online') online++;
        else if (p.status === 'idle') idle++;
        else if (p.status === 'dnd') dnd++;
        else offlinePresence++;
      }
    }
    const onlineCount = online + idle + dnd;

    const mem = this.members.get(guildId);
    const membersKnown = !!mem && mem.size > 0;
    let botCount = null;
    if (membersKnown) {
      botCount = 0;
      for (const m of mem.values()) if (m.user && m.user.bot) botCount++;
    }

    const memberCount = Math.max(g.member_count || 0, mem ? mem.size : 0, onlineCount);
    const offlineCount = Math.max(0, memberCount - onlineCount);

    return {
      id: g.id,
      name: g.name,
      icon: g.icon,
      ownerId: g.owner_id,
      features: g.features,
      unavailable: !!g.unavailable,
      memberCount,
      onlineCount,
      offlineCount,
      botCount,
      membersKnown,
      presenceBreakdown: { online, idle, dnd, offlinePresence },
      channelCount: this.listChannels(guildId).length,
      textChannelCount: this.listChannels(guildId).filter((c) => c.is_text).length,
      lastEventAt: new Date().toISOString(),
    };
  }

  listGuilds() {
    const out = [];
    for (const id of this.guilds.keys()) {
      const summary = this.computeGuild(id);
      if (summary) out.push(summary);
    }
    return out.sort((a, b) => b.memberCount - a.memberCount);
  }

  snapshot() {
    return {
      bot: this.botUser,
      connection: this.connection,
      serverTime: new Date().toISOString(),
      guilds: this.listGuilds(),
      counters: this.counters,
    };
  }

  totals() {
    let members = 0;
    let online = 0;
    let bots = 0;
    let botsKnown = false;
    let channels = 0;
    for (const g of this.listGuilds()) {
      members += g.memberCount;
      online += g.onlineCount;
      channels += g.textChannelCount;
      if (g.botCount != null) {
        bots += g.botCount;
        botsKnown = true;
      }
    }
    return { guilds: this.guilds.size, members, online, bots: botsKnown ? bots : null, textChannels: channels };
  }
}

module.exports = { Store, TEXT_CHANNEL_TYPES, ONLINE_STATUSES };
