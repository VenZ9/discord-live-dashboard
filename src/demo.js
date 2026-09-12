'use strict';

/**
 * Demo / simulation client.
 *
 * Emits exactly the same event names and payload shapes as DiscordClient, so
 * the whole real-time pipeline (state store -> SSE -> browser) can be exercised
 * and verified without a bot token.  All data here is synthetic.
 */

const { EventEmitter } = require('events');

const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let idCounter = 0;
const snowflake = () => String(1000000000000000000n + BigInt(++idCounter));

// Channel IDs use a separate high range so they can never collide across
// guilds (the user ID counter and the channel ID counter are independent).
let channelCounter = 0;
const channelId = () => String(4000000000000000000n + BigInt(++channelCounter));

const BLUEPRINTS = [
  {
    id: '111111111111111101',
    name: 'Aurora SMP',
    memberCount: 348,
    onlineCount: 97,
    botCount: 9,
    channels: ['announcements', 'general', 'build-showcase', 'memes', 'looking-for-group', 'support', 'off-topic'],
  },
  {
    id: '111111111111111102',
    name: 'Pixel Forge',
    memberCount: 264,
    onlineCount: 61,
    botCount: 14,
    channels: ['welcome', 'general', 'dev-log', 'showcase', 'help', 'jobs'],
  },
  {
    id: '111111111111111103',
    name: 'Lo-fi Lounge',
    memberCount: 212,
    onlineCount: 44,
    botCount: 5,
    channels: ['general', 'music', 'recommendations', 'chill-chat'],
  },
  {
    id: '111111111111111104',
    name: 'Game Night HQ',
    memberCount: 123,
    onlineCount: 29,
    botCount: 8,
    channels: ['general', 'matchmaking', 'tournaments', 'clips'],
  },
  {
    id: '111111111111111105',
    name: 'Study Hall',
    memberCount: 90,
    onlineCount: 18,
    botCount: 3,
    channels: ['general', 'resources', 'accountability', 'wins'],
  },
];

const HANDLES = [
  'nova', 'kaito', 'lumen', 'quokka', 'rune', 'sable', 'tarn', 'umbra', 'vesper', 'wren',
  'xen', 'yara', 'zephyr', 'aster', 'briar', 'cypress', 'drift', 'ember', 'fable', 'gale',
  'harbor', 'iris', 'juno', 'kestrel', 'mica', 'nimbus', 'onyx', 'pallas', 'quill', 'raven',
  'solace', 'thistle', 'vale', 'wisp', 'yarrow', 'zinnia', 'cobalt', 'dune', 'flint', 'grove',
];

const CHATTER = [
  'morning everyone 👋',
  'anyone up for a build session later?',
  'just pushed the fix, should be live now',
  'that render looks so clean',
  'brb grabbing coffee',
  'did the server restart again?',
  'new season starts this weekend right?',
  'I finally beat that boss lol',
  'can someone review my PR when free?',
  'the latency is way better today',
  'who wants to team up for the tournament',
  'sharing my coordinates, come say hi',
  'this update broke my config, anyone else?',
  'found a great seed, posting it soon',
  'happy to help with the setup, ping me',
  'ok that clip is genuinely impressive',
  'voting on the new map tonight',
  'thanks for the help earlier!',
  'streaming in 10 if anyone wants to watch',
  'the new channel layout is much nicer',
  'lol that timing was perfect',
  'does anyone have the invite link handy?',
  'heads up: maintenance in an hour',
  'finally finished the base, tour later',
];

class DemoClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.debug = !!options.debug;
    this.destroyed = false;
    this.timers = [];
    this.guilds = [];
    this.user = {
      id: '900000000000000001',
      username: 'live-dashboard-demo',
      global_name: 'Live Dashboard (Demo)',
      discriminator: '0001',
      avatar: null,
      bot: true,
    };
  }

  log(...args) {
    if (this.debug) console.log('[demo]', ...args);
  }

  buildGuild(bp) {
    const members = [];
    const presences = [];
    const channels = [];

    bp.channels.forEach((name, i) => {
      channels.push({
        id: channelId(),
        guild_id: bp.id,
        name,
        type: 0, // GUILD_TEXT
        position: i,
        parent_id: null,
        topic: null,
        nsfw: false,
      });
    });

    // Category channel for realism (ignored by the message view).
    channels.push({
      id: channelId(),
      guild_id: bp.id,
      name: 'TEXT CHANNELS',
      type: 4, // GUILD_CATEGORY
      position: 0,
      parent_id: null,
    });

    for (let i = 0; i < bp.botCount; i++) {
      const user = {
        id: snowflake(),
        username: `${pick(HANDLES)}-bot`,
        global_name: null,
        discriminator: String(randInt(1000, 9999)),
        avatar: null,
        bot: true,
      };
      members.push({ user, roles: [], joined_at: new Date(Date.now() - randInt(1, 400) * 86400000).toISOString() });
      presences.push({
        user: { id: user.id },
        status: 'online',
        activities: [],
        client_status: { desktop: 'online' },
      });
    }

    for (let i = 0; i < bp.memberCount; i++) {
      const user = {
        id: snowflake(),
        username: `${pick(HANDLES)}${randInt(10, 9999)}`,
        global_name: null,
        discriminator: String(randInt(1000, 9999)),
        avatar: null,
        bot: false,
      };
      members.push({ user, roles: [], joined_at: new Date(Date.now() - randInt(1, 900) * 86400000).toISOString() });
    }

    // Mark `onlineCount` of the human members as present.
    const humans = members.filter((m) => !m.user.bot);
    const shuffled = humans.slice().sort(() => Math.random() - 0.5);
    for (const m of shuffled.slice(0, Math.max(0, bp.onlineCount - bp.botCount))) {
      const roll = Math.random();
      const status = roll < 0.82 ? 'online' : roll < 0.94 ? 'idle' : 'dnd';
      presences.push({
        user: { id: m.user.id },
        status,
        activities: status === 'online' && Math.random() < 0.3
          ? [{ name: pick(['Minecraft', 'Visual Studio Code', 'Spotify', 'Elden Ring']), type: 0 }]
          : [],
        client_status: { desktop: status },
      });
    }

    return {
      id: bp.id,
      name: bp.name,
      icon: null,
      owner_id: members[members.length - 1].user.id,
      features: ['COMMUNITY', 'NEWS'],
      member_count: members.length,
      members,
      presences,
      channels,
    };
  }

  start() {
    this.emit('state', { state: 'connecting', error: null, mode: 'demo' });
    this.guilds = BLUEPRINTS.map((bp) => this.buildGuild(bp));

    this.timeout(async () => {
      if (this.destroyed) return;
      this.emit('user', this.user);
      this.emit('ready', {
        session_id: 'demo-session',
        resume_gateway_url: 'wss://gateway.discord.gg',
        user: this.user,
        guilds: this.guilds.map((g) => ({ id: g.id, unavailable: false })),
      });
      await sleep(60);
      for (const g of this.guilds) {
        if (this.destroyed) return;
        this.emit('guildCreate', g);
        await sleep(40);
      }
      this.emit('state', { state: 'ready', error: null, mode: 'demo' });
      this.startLoops();
    }, 300);

    return Promise.resolve();
  }

  timeout(fn, ms) {
    const t = setTimeout(() => {
      if (this.destroyed) return;
      fn();
    }, ms);
    this.timers.push(t);
    return t;
  }

  loop(fn, ms) {
    const t = setInterval(() => {
      if (this.destroyed) return;
      fn();
    }, ms);
    this.timers.push(t);
    return t;
  }

  startLoops() {
    // Presence churn: users coming online / going idle / going offline.
    this.loop(() => {
      const g = pick(this.guilds);
      const humans = g.members.filter((m) => !m.user.bot);
      const member = pick(humans);
      const roll = Math.random();
      const status = roll < 0.55 ? 'online' : roll < 0.72 ? 'idle' : roll < 0.82 ? 'dnd' : 'offline';
      this.emit('presenceUpdate', {
        guild_id: g.id,
        user: { id: member.user.id },
        status,
        activities: status === 'online' && Math.random() < 0.25
          ? [{ name: pick(['Minecraft', 'Spotify', 'Discord']), type: 0 }]
          : [],
        client_status: status === 'offline' ? {} : { desktop: status },
      });
    }, 1200);

    // Live chat.
    this.loop(() => {
      const g = pick(this.guilds);
      const textChannels = g.channels.filter((c) => c.type === 0);
      const channel = pick(textChannels);
      const author = pick(g.members);
      this.emit('messageCreate', {
        id: snowflake(),
        channel_id: channel.id,
        guild_id: g.id,
        author: {
          id: author.user.id,
          username: author.user.username,
          global_name: author.user.global_name,
          discriminator: author.user.discriminator,
          avatar: null,
          bot: author.user.bot,
        },
        content: pick(CHATTER),
        timestamp: new Date().toISOString(),
        edited_timestamp: null,
        attachments: [],
        embeds: [],
        mentions: [],
        type: 0,
      });
    }, 2600);

    // Membership churn.
    this.loop(() => {
      const g = pick(this.guilds);
      if (Math.random() < 0.45) {
        const user = {
          id: snowflake(),
          username: `${pick(HANDLES)}${randInt(10, 9999)}`,
          global_name: null,
          discriminator: String(randInt(1000, 9999)),
          avatar: null,
          bot: false,
        };
        const member = { user, roles: [], joined_at: new Date().toISOString() };
        g.members.push(member);
        g.member_count = g.members.length;
        this.emit('guildMemberAdd', { guild_id: g.id, ...member });
      } else {
        const humans = g.members.filter((m) => !m.user.bot);
        const victim = pick(humans);
        g.members = g.members.filter((m) => m.user.id !== victim.user.id);
        g.member_count = g.members.length;
        this.emit('guildMemberRemove', { guild_id: g.id, user: { id: victim.user.id } });
      }
    }, 9000);
  }

  destroy() {
    this.destroyed = true;
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
  }
}

module.exports = { DemoClient };
