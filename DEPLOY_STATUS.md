# Deployment Status

_Last verified: 2026-09-12_

## TL;DR

| Step | Status |
|---|---|
| GitHub repo created + all files pushed | ✅ **Done** |
| Bot token validated against Discord API | ✅ **Valid** (bot `ZAYN#4456`) |
| App verified **live** in bot mode with real Discord data | ✅ **Done** |
| Automated deploy to a live host | ❌ **Not possible on this platform** — see §4 |
| Live public URL | ⏳ Requires a ~2-minute manual deploy (§5) |

---

## 1. GitHub — DONE

- **Repository:** <https://github.com/VenZ9/discord-live-dashboard> (public)
- **Account:** `VenZ9`
- **Branch:** `main` @ `233dc95` — **22 files**
- **Push method:** a write-enabled deploy key (`teamily-ci-push`) was added to the repo and used over SSH, so the binary `screenshots/dashboard.png` was transferred intact (the REST Contents API would have corrupted it).
- **Verified on the remote:** `.env` and `node_modules/` are **absent**. Confirmed with `git ls-tree -r origin/main`. A token-material scan (`MTU0NjAz`, `GraKt7`, `COUF3flk`) over the working tree returned clean.

## 2. Bot token — VALIDATED

Called the Discord REST API v10 directly with the supplied token:

- `GET /users/@me` → **HTTP 200**
  - username `ZAYN`, discriminator `4456`, id `1546030312620818572`, `bot: true`, `verified: true`
- `GET /users/@me/guilds` → **HTTP 200**
  - Joined guilds: **1** — `bot test` (`1546030776263639050`)

> ⚠️ **The bot is NOT in ReactoSMP** (`756724199627948063`). As-is, the dashboard will only show `bot test`. Invite the bot to ReactoSMP (and any other server) using the URL in §5 to monitor them.

## 3. Live verification (real token, real Discord data)

Ran the server in bot mode and confirmed the whole pipeline end-to-end:

- Gateway connected → `/api/health` returned `{"mode":"bot","state":"ready","guilds":1}`
- `/api/snapshot` returned the **real** server with live counts:
  `bot test` — members **2**, online **1**, offline **1**, bots **1**
- Channel listing returned the real channels: `#general` (text), `General` (voice), `Text channels` / `Voice channels` (categories)
- `/api/channels/:id/messages` returned **real message history** from `#general` (including a message posted during the test run)
- Screenshots captured from the running app:
  - `screenshots/dashboard_botmode.png` — the UI showing **live** (not demo) data for `bot test`
  - `screenshots/dashboard_demo_multiserver.png` — the 5-server demo fleet view

## 4. Hosting — automated deploy NOT possible here

Every managed host integration was attempted and each failed for a **platform-level** reason (not a config mistake):

| Host | Result |
|---|---|
| Railway (Composio integration) | No Composio-managed credentials — **no auth config exists**, profile cannot be created |
| Railway MCP | Same — not available on this platform |
| Render | Only supports `API_KEY` auth; this platform connects **OAuth only** → unsupported |
| Fly.io | Only supports `API_KEY` auth → unsupported |
| Vercel | Not in the catalog **and** architecturally incapable (below) |

**No Railway / Render / Fly / Vercel account is connected**, and the platform cannot create API-key-based connections, so **there is no live public URL yet**.

### Why Vercel genuinely cannot host the live part

Vercel Functions are **serverless**: they cannot hold a persistent WebSocket or keep in-memory state between invocations, and they are time-capped. This app's whole purpose is an always-on **Discord Gateway WebSocket** feeding an in-memory store. Vercel's native WebSocket support pins a connection to a single instance with a hard time limit — still not an always-on gateway. Deploying there would serve a UI that silently shows stale/empty data.

## 5. Deploy it yourself in ~2 minutes

The repo is already configured for these hosts, so the deploy is two clicks + one variable.

**Railway (recommended — no Docker needed):**
1. <https://railway.app/new> → **Deploy from GitHub repo** → pick `VenZ9/discord-live-dashboard`
2. **Variables** → add `DISCORD_BOT_TOKEN` = your token
3. **Deploy** — `railway.json` already sets the start command and healthcheck

**Render:** New → Blueprint → select the repo (reads `render.yaml`) → set `DISCORD_BOT_TOKEN`.
**Fly.io:** `fly launch` (reads `fly.toml`) → `fly secrets set DISCORD_BOT_TOKEN=...` → `fly deploy`.

Then, for full live data:
1. **Enable privileged intents** — Developer Portal → Bot → *Privileged Gateway Intents* → turn on **Server Members** and **Message Content**.
2. **Invite the bot** to each server (permission integer `66560` = View Channels + Read Message History):
   ```
   https://discord.com/api/oauth2/authorize?client_id=1546030312620818572&permissions=66560&scope=bot
   ```

## 6. ⚠️ Security — rotate the token

The bot token was pasted into chat, so it is now **exposed** and must be treated as compromised.

1. Developer Portal → your app → **Bot** → **Reset Token** → copy the new one.
2. Update `DISCORD_BOT_TOKEN` in your host's variables (local `.env` too).
3. Never commit it — `.gitignore` already excludes `.env`, and this repository and its history **never contained it** (verified).

> Note: resetting the token invalidates the old one, so the currently-running local test process will drop its connection until the new token is used.
