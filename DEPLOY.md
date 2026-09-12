# Deploying the Discord Live Dashboard

## TL;DR — read this first

**Vercel cannot host this app's live functionality.** It is not a configuration
problem and no amount of `vercel.json` tweaking fixes it: the app's whole purpose
is to hold a **persistent Discord Gateway WebSocket** and keep **state in memory**,
and Vercel Functions are **serverless** — short-lived, stateless, and time-limited.

| Requirement of this app | Vercel Functions | Works? |
|---|---|---|
| Persistent outbound WebSocket to `gateway.discord.gg` | Pinned to one function instance; capped (300 s free / 30 min extended); future connections may land on a different instance | ❌ |
| In-memory state shared across requests (guilds, members, message buffers) | Invocations are ephemeral; nothing is shared between them | ❌ |
| Process start-up that IDENTIFYs and stays `READY` for days | Functions are created and destroyed per request/burst | ❌ |
| SSE `/api/stream` pushed live from that gateway connection | SSE *streaming works*, but the process feeding it is recycled; the gateway dies with it | ⚠️ partial |

Vercel's own documentation says this directly: *"Persistent WebSocket connections,
stream processors, and anything that needs continuous execution don't work well with
serverless time limits."* Even Vercel's newer native WebSocket support (public beta)
pins a connection to **one function instance** and caps it — it does not survive into
an always-on gateway process.

**So: deploy the service to a host that runs long-running processes.** The repo is
already configured for several of them — pick one below.

---

## Option A — Railway (recommended, one click from GitHub)

Railway runs a persistent always-on process: no cold starts, no connection timeouts.

1. Push this repo to GitHub (see `GITHUB_PUSH` steps in the main README or below).
2. Railway → **New Project → Deploy from GitHub repo** → pick `discord-live-dashboard`.
3. Railway reads `railway.json` (start command + `/api/health` healthcheck) automatically.
4. **Variables tab → add `DISCORD_BOT_TOKEN`** (and optionally `GUILD_IDS`, `HISTORY_LIMIT`).
5. **Settings → Networking → Generate Domain** to get a public HTTPS URL.

> Add a persistent volume if you ever want message history to survive restarts;
> today all state is in memory by design, so none is required.

## Option B — Render

1. Render → **New → Blueprint** → connect the repo. `render.yaml` is detected.
2. Set `DISCORD_BOT_TOKEN` in the dashboard (`sync: false` keeps it out of git).
3. **Use the `starter` plan or above.** The free plan **sleeps after inactivity**,
   which drops the gateway connection and stops live updates.

## Option C — Fly.io (Docker)

```bash
fly launch --no-deploy          # reads fly.toml / Dockerfile
fly secrets set DISCORD_BOT_TOKEN=your_bot_token_here
fly deploy
```

`fly.toml` sets `auto_stop_machines = false` and `min_machines_running = 1` so the
machine never sleeps and the gateway stays connected.

## Option D — Any VPS / Docker host

```bash
docker build -t discord-live-dashboard .
docker run -d --restart=always -p 3000:3000 \
  -e DISCORD_BOT_TOKEN=your_bot_token_here \
  discord-live-dashboard
```

Run it behind nginx/Caddy for TLS. The container ships a `HEALTHCHECK` against
`/api/health`.

---

## Option E — the Vercel-only path (fixes the architecture, not Vercel)

If you specifically *want* the dashboard UI on Vercel, split the app in two and
let Vercel serve only the stateless half:

```
┌─────────────────────────┐        ┌──────────────────────────┐
│  Worker (Railway/Fly/   │        │  Vercel Function        │
│  Render/VPS)            │        │  (UI + thin API)        │
│                         │        │                         │
│  Discord Gateway  ──────┼──► Redis/Upstash ──►  reads ─────►│  serves public/
│  (always-on process)    │  writes state          state     │  + /api/*
└─────────────────────────┘        └──────────────────────────┘
```

1. **Worker host:** run this app as-is (minus the static UI) to hold the gateway
   connection and write each snapshot/event into **Redis or Upstash**.
2. **Vercel:** deploy a stateless Next.js/Express app that reads from that store and
   serves the UI. Poll or use Upstash's REST-based pub/sub for live pushes.
3. Cost/complexity goes **up** versus Options A–D, and you still need an always-on
   host for step 1 — so this only makes sense if Vercel must be in the stack.

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DISCORD_BOT_TOKEN` | **yes** (live mode) | Bot token. Without it the app starts in demo mode. |
| `DEMO_MODE` | no | `1` forces the synthetic-data simulator. |
| `PORT` | no | HTTP port (default `3000`; most hosts inject this). |
| `GUILD_IDS` | no | Comma-separated server IDs to monitor; empty = all joined servers. |
| `HISTORY_LIMIT` | no | Messages pulled per channel view, 1–100 (default `100`). |
| `MAX_MESSAGES_PER_CHANNEL` | no | In-memory buffer per channel (default `200`). |

**Never commit `.env`** — it is already listed in `.gitignore`.

> ⚠️ **Do not put the bot token in `vercel.json`, `render.yaml`, or any committed
> file.** Set it through each host's secret/env UI. A leaked bot token lets anyone
> read every message the bot can see.

---

## Pushing to GitHub (manual, if the integration isn't connected)

```bash
cd documents/discord-live-dashboard_v2
git init -b main
git add .
git commit -m "Discord live dashboard: gateway-driven real-time counts + per-channel chat"
git remote add origin https://github.com/<your-username>/discord-live-dashboard.git
git push -u origin main
```

## Bot prerequisites (required on every host)

1. Create the app + bot at <https://discord.com/developers/applications> → copy the token.
2. **Bot → Privileged Gateway Intents:** enable **Server Members** (needed for member/
   bot/offline counts and join/leave events) and **Message Content** (needed for message
   text; without it messages arrive empty).
3. Permissions: **View Channels** + **Read Message History** (integer `66560`).
4. Invite it to every server you want monitored:
   `https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=66560&scope=bot`

## Verify a deployment

```bash
curl https://your-app.example.com/api/health     # {"ok":true,"state":"ready",...}
curl https://your-app.example.com/api/guilds     # live per-server counts
```

Open the root URL: the badge must read **live** (not `live (demo)`), which proves the
gateway is connected and the token is valid.
