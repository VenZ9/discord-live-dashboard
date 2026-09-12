# Discord Live Dashboard

A real-time dashboard that monitors **every Discord server your bot has joined** and
streams live data to the browser over SSE.

- **Per server:** total members, online, offline, and bot counts — updated **live**.
- **Per server:** all channels, grouped under their server.
- **Per channel:** a live chat view showing messages the instant they are posted.
- **Zero polling of the UI:** counts and messages are pushed from the Discord
  Gateway → server → browser over Server-Sent Events.

---

## Deploying

Hosting configs are included for **Railway, Render, Fly.io, Docker and any VPS**
(`railway.json`, `render.yaml`, `fly.toml`, `Dockerfile`, `Procfile`).

> ⚠️ **Vercel cannot host the live part of this app.** Vercel Functions are
> serverless, so they cannot hold the persistent Discord Gateway WebSocket or keep
> in-memory state between invocations. See **[DEPLOY.md](DEPLOY.md)** for the full
> explanation and the recommended hosts.

**Quickest path:** push to GitHub → Railway/Render "Deploy from repo" → set
`DISCORD_BOT_TOKEN` → done. Steps for every host are in [DEPLOY.md](DEPLOY.md).

> 📌 **Current status of this deployment:** see **[DEPLOY_STATUS.md](DEPLOY_STATUS.md)** —
> what was verified live, and what still needs doing.

> 🔎 **Status update (2026-09-12):** this app has been **run and verified live in bot
> mode against the real Discord Gateway** — it reports real per-server counts and real
> channel message history. See [DEPLOY_STATUS.md](DEPLOY_STATUS.md).

---

## Quick start

```bash
npm install
cp .env.example .env          # then set DISCORD_BOT_TOKEN=<your token>

# Option A - see it working right now, no token needed:
npm run demo                  # -> http://localhost:3000  (synthetic live data)

# Option B - real data from Discord:
npm start                     # -> http://localhost:3000  (Discord Gateway)
```

**To go live you must supply a bot token.** The bot then needs:

- the **Message Content** and **Server Members** privileged intents enabled, and
- the **View Channels** + **Read Message History** permissions, and
- an invitation to every server you want monitored — including
  **ReactoSMP** (guild ID `756724199627948063`).

Full step-by-step instructions are in sections 2 and 3 below.

---

## 1. Why a bot is required

The OAuth user connection (identify / guilds / messages.read) can list a user's
servers but **cannot read a guild's channel list or message history**. Discord
only exposes that data to a **bot** that is a member of the guild. So this app
runs a bot: it connects to the Discord Gateway WebSocket, receives events, and
fans them out to the dashboard.

```
Discord Gateway (WebSocket)
        │  GUILD_CREATE · PRESENCE_UPDATE · GUILD_MEMBER_ADD/REMOVE · MESSAGE_CREATE
        ▼
  src/discord.js   ──►  src/state.js   ──►  src/server.js  ──SSE──►  public/app.js
   (gateway client)      (live store)       (HTTP + stream)          (dashboard)
```

---

## 2. Create the bot (one-time setup)

1. Open the **Discord Developer Portal** → <https://discord.com/developers/applications>
2. **New Application**, give it a name → **Create**.
3. Left sidebar → **Bot**.
4. Click **Reset Token** → **Copy**. This is your `DISCORD_BOT_TOKEN`.
   Treat it like a password — never commit it or paste it into a chat.
5. Still on the **Bot** page, scroll to **Privileged Gateway Intents** and enable **BOTH**:
   - ✅ **Server Members Intent** → required for member counts, bot counts, join/leave events
   - ✅ **Message Content Intent** → required to read message text (without it, `content` arrives empty)

   > **Presence data.** Online/offline counts come from the presence stream. Discord does
   > not deliver presences for guilds where the bot lacks the Members intent, so keep
   > **Server Members Intent** on. During the first seconds after startup the online
   > count may read 0 until presences arrive — it fills in as events stream.

   > Bots in **100+ servers** must be verified before the privileged intents can be
   > enabled. For a personal/dashboard bot this is usually not a concern.

6. Left sidebar → **OAuth2 → General** → copy the **Client ID**.

### Invite the bot to your servers

Build the invite URL with your Client ID (permission integer `66560` =
View Channels + Read Message History, which is all a read-only dashboard needs):

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=66560&scope=bot
```

Open it, pick the server, authorize. **Repeat for every server you want monitored.**
The dashboard automatically shows every server the bot has joined.

---

## 3. Configure and run

```bash
cd documents/discord-live-dashboard

# 1. install dependencies (express, ws, dotenv)
npm install

# 2. create your config
cp .env.example .env
#    then edit .env and set DISCORD_BOT_TOKEN=<your token>

# 3. start
npm start
```

Open **<http://localhost:3000>**.

### Try it without a token first (demo mode)

Not ready to create a bot? The built-in simulator emits the exact same event
shapes, so you can watch counts and messages update live immediately:

```bash
npm run demo          # or: DEMO_MODE=1 npm start
```

The UI shows **`live (demo)`** in the status pill so simulated data is never
mistaken for real data. Demo data is synthetic and clearly labelled.

### Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_BOT_TOKEN` | — | Bot token. **If empty, the app starts in demo mode.** |
| `PORT` | `3000` | HTTP port. |
| `DEMO_MODE` | `0` | `1` forces the simulator even if a token is set. |
| `GUILD_IDS` | *(all)* | Comma-separated server IDs to monitor. Empty = every joined server. |
| `HISTORY_LIMIT` | `100` | Messages pulled per channel when you open a chat view. |
| `MAX_MESSAGES_PER_CHANNEL` | `200` | In-memory live buffer per channel. |
| `COUNT_REFRESH_MS` | `60000` | How often to re-check member counts via REST. |
| `DEBUG` | `0` | `1` logs raw gateway traffic. |

---

## 4. Using the dashboard

- **Left column** — every server the bot has joined, with live Members / Online / Offline / Bots counts.
- **Middle column** — headline stats for the selected server, and its channels grouped into *Text channels* and *Other channels*. The number on a channel is how many messages are buffered locally.
- **Right column** — live chat for the selected channel. Existing history loads once, then new messages appear as they are posted (a brief highlight marks fresh ones).
- **Sync members** button — re-requests the full member list from Discord (bot mode only).
- **Status pill** (top right) — `live` when the gateway is connected, `connecting…` while it reconnects, `error` on failure.

---

## 5. HTTP API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness, mode, guild count, connected listeners. |
| `GET /api/config` | Effective configuration. |
| `GET /api/snapshot` | Full state: bot, connection, totals, servers, channels per server. |
| `GET /api/guilds` | Server list + live counts. |
| `GET /api/guilds/:id` | One server + its channels. |
| `GET /api/guilds/:id/channels` | Channels for one server. |
| `GET /api/channels/:id/messages?limit=100` | Channel history (Discord REST, cached in the live buffer). |
| `POST /api/guilds/:id/sync-members` | Ask Discord for the full member list. |
| `GET /api/stream` | **SSE stream** — `init`, `state`, `guilds`, `guild`, `channels`, `totals`, `message`, `messageUpdate`, `messageDelete`, `memberEvent`. |

---

## 6. How the counts are derived (and their limits)

Discord does not provide a single "offline count" number, so the dashboard
computes it from what the gateway gives it:

| Metric | Source |
|---|---|
| **Total members** | `GUILD_CREATE.member_count`, cross-checked with `approximate_member_count` (REST) and the locally known member set. |
| **Online** | Distinct members with a live presence of `online` + `idle` + `dnd` (`PRESENCE_UPDATE`, `GUILD_CREATE.presences`). |
| **Offline** | `max(0, total − online)`. |
| **Bots** | Members whose `user.bot` is true, from the member cache (needs the **Server Members Intent**). Shown as `—` until members are known. |

Reading these honestly:

- **Online / offline are live presence signals**, and Discord only pushes presences
  for members the bot can see. In very large servers the member list is streamed in
  chunks (`GUILD_MEMBERS_CHUNK`), so counts converge over the first few seconds.
- **Total member count is authoritative** (it is the guild's own number); offline is
  therefore the difference, not a separate Discord-provided figure.
- Counts are recomputed and re-pushed at most **~3×/second per server** (bursts are
  coalesced), so a busy server cannot flood the browser.

---

## 7. Verify it works

With the server running (demo or bot mode):

```bash
node test/realtime-check.js http://localhost:3000
```

This is a real end-to-end check, not a liveness ping. It asserts that:

1. the snapshot returns servers with numeric counts and channels **correctly grouped per server**;
2. `textChannelCount` matches the channels actually listed, and `online + offline == members`;
3. the SSE stream opens with the right content type;
4. **at least one server's counts actually change while listening** — i.e. the data is live, not a static snapshot;
5. live `MESSAGE_CREATE` events stream through.

Expected output ends with `RESULT: PASSED`.

---

## 8. Project layout

```
discord-live-dashboard/
├── package.json
├── .env.example
├── README.md
├── src/
│   ├── server.js     HTTP server, REST endpoints, SSE broadcast, event wiring
│   ├── discord.js    Gateway client: IDENTIFY/RESUME, heartbeats, event fan-out + REST wrapper
│   ├── state.js      In-memory live store: guilds, channels, members, presences, messages
│   └── demo.js       Synthetic client emitting identical events (no token needed)
├── public/
│   ├── index.html    Three-column dashboard shell
│   ├── styles.css
│   └── app.js        SSE client + reactive rendering
├── test/
│   └── realtime-check.js
└── screenshots/
    └── dashboard.png
```

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Gateway closed with fatal code 4014` | Privileged intents are off — enable **Server Members** and **Message Content** in the Developer Portal. |
| `4013 / 4012` | Invalid intent value — this build uses the correct intents; restart after enabling them. |
| Message text arrives empty | **Message Content Intent** is disabled. |
| Bot count shows `—` | **Server Members Intent** is disabled, or members are still streaming in. |
| Online count reads 0 | Presences have not arrived yet — wait a few seconds; check the Members intent. |
| A server is missing | The bot has not been invited to it. Re-run the invite URL. |
| `Failed to fetch channel history … 403` | The bot lacks **Read Message History** in that channel (channel-level permission overwrite). |
| `401 Invalid bot token` | Wrong/rotated token — reset it in the portal and update `.env`. |
| Counts freeze | The gateway is reconnecting; the status pill shows `connecting…`. It resumes automatically with backoff. |

---

## 10. Notes

- The dashboard is **read-only** — it never sends messages, and it holds all state in
  memory (no database, nothing written to disk).
- The only credential is the bot token; it is read from `.env` and never exposed to
  the browser.
- Reading a community's message history may be subject to that server's rules and to
  Discord's Terms of Service. Make sure you have the right to monitor any server you
  point this at.
