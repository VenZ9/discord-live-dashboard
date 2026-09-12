# Deploying the Discord Live Dashboard on Render — step-by-step

**Repo:** https://github.com/VenZ9/discord-live-dashboard
**Blueprint file:** `render.yaml` (already in the repo root — no editing needed)
**Time:** ~5 minutes on the Blueprint path.

This app is a **long-running Node server**, not a static site. It holds a persistent
WebSocket to Discord's Gateway and streams live updates to the browser over SSE. Every
instruction below is written for that reality — in particular, **read section 5** before
choosing the Free plan.

---

## 0. Before you start

Have these ready. Three of the four are one-time Discord Developer Portal actions.

| # | Prerequisite | Where |
|---|---|---|
| 1 | Repo exists and is pushed | https://github.com/VenZ9/discord-live-dashboard |
| 2 | Bot token | Developer Portal → your app → **Bot** → *Reset Token* |
| 3 | **Server Members** + **Message Content** privileged intents **ON** | Developer Portal → your app → **Bot** → *Privileged Gateway Intents* |
| 4 | Bot invited to the servers you want to monitor | see section 7 |

Without #3 the dashboard will connect but show **0 members / no presence / empty message text**.
Without #4 it will connect and show nothing but `bot test`.

---

## 1. Create a Render account and connect GitHub

1. Go to **https://render.com** and click **Get Started** (top right).
2. Choose **GitHub** as the sign-up method. (Using GitHub here does double duty — it creates
   the account *and* starts the repo authorization.)
3. Click **Authorize Render** on GitHub's OAuth screen. Render only ever gets read access to
   pull your code — it cannot push to your repos.
4. GitHub will ask which repositories Render may see. Pick one:
   - **All repositories** — simplest, and lets you deploy future projects without revisiting this.
   - **Only select repositories** → choose **`discord-live-dashboard`** → *Install*.
5. You'll land on the Render dashboard. If it asks you to pick a workspace, the default
   **Hobby** workspace is fine (that's the free one).

> **Note on this repo:** `discord-live-dashboard` is **public**, so Render *could* build it from
> the public URL without GitHub OAuth. Do it through GitHub anyway — that's what enables
> **auto-deploy on push**, which you want.

---

## 2. Choose your path: Blueprint vs Manual

Both produce an identical service. Pick **Blueprint** unless you specifically want to
hand-set every field.

| | **Blueprint** (recommended) | **Manual Web Service** |
|---|---|---|
| How it reads config | Parses `render.yaml` from the repo | You type every setting |
| Fields to enter | ~2 (a name + the token) | ~10 |
| Stays in sync with repo | Yes — edit `render.yaml`, next deploy applies it | No — you re-edit in the UI |
| Best for | Getting live in one click | Learning the settings / tweaking a lot |

---

### 2A. Blueprint path (recommended)

1. Open this deeplink — it pre-fills the repo:

   **https://dashboard.render.com/blueprint/new?repo=https://github.com/VenZ9/discord-live-dashboard**

   *(Equivalent route by hand: **New +** → **Blueprint** → pick `discord-live-dashboard` → **Connect**.)*
   *(Render also documents a `https://render.com/deploy?repo=…` link that redirects to the same place.)*

2. Render clones the repo and reads `render.yaml`. It will show one service to create:
   **`discord-live-dashboard`** — a **Web Service**, runtime **Node**.

3. Because `render.yaml` declares the token with `sync: false`, Render **prompts you for
   `DISCORD_BOT_TOKEN`** right here. Paste your bot token. (This is the whole point of
   `sync: false` — the value is asked for at deploy time and never lives in git.)

4. Give the Blueprint itself a name (e.g. `discord-dashboard`) → click **Apply**.

5. Render creates the service and immediately starts the first build. Watch it under the
   service's **Logs** / **Events** tab.

The blueprint already sets: plan `starter`, build `npm install`, start `node src/server.js`,
health check `/api/health`, auto-deploy on, and the env vars in section 4.

---

### 2B. Manual Web Service path

**New +** → **Web Service** → connect **`discord-live-dashboard`**, then enter exactly this:

| Field | Value |
|---|---|
| **Name** | `discord-live-dashboard` (becomes the URL: `discord-live-dashboard.onrender.com`) |
| **Region** | Closest to you — `Singapore` for India, else `Frankfurt` / `Oregon` / `Ohio` / `Virginia` |
| **Branch** | `main` |
| **Root Directory** | *(leave empty — the app is at the repo root)* |
| **Runtime / Environment** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | `Starter` (recommended) — or `Free`, see section 5 |
| **Health Check Path** | `/api/health` |
| **Auto-Deploy** | `Yes` |

Then, before clicking **Create Web Service**, open **Advanced → Environment Variables** and add
the variables from section 4.

**Why these exact values:** `npm start` runs `node src/server.js` (see `package.json`).
`/api/health` is a lightweight endpoint that returns 200 as soon as the HTTP server is up —
it's the file's own health path, so Render's probe and the app agree.

---

## 3. Set the environment variables

Service → **Environment** → **Add Environment Variable**. These are exactly the variables from
the repo's `.env.example`:

| Key | Value | Required? |
|---|---|---|
| `DISCORD_BOT_TOKEN` | your bot token | **Yes** — omit it and the app boots in demo mode |
| `DEMO_MODE` | `0` | Yes — `1` forces the simulator |
| `PORT` | `3000` | Set by `render.yaml`; optional |
| `NODE_VERSION` | `20` | Optional — pins the Node major |
| `GUILD_IDS` | *(empty)* | Optional — comma-separated guild IDs to monitor a subset |
| `HISTORY_LIMIT` | `100` | Optional — messages pulled per channel (1–100) |
| `MAX_MESSAGES_PER_CHANNEL` | `200` | Optional — in-memory buffer per channel |

**Notes**

- **`PORT`:** Render's default is `10000`; the app reads `PORT` and binds to it, so either
  value works. `render.yaml` pins `3000` for consistency with local runs. Just don't set it
  to `443` — Render reserves that.
- **Changing any env var triggers a redeploy.** In Render 3.x the button reads
  *Save, rebuild, and deploy*. That's expected: a new process must pick up the new value.
- **The token must never be committed.** It isn't: `.gitignore` excludes `.env`, and
  `render.yaml` uses `sync: false` so the value only ever lives in Render's dashboard. Verified
  — the git tree contains no token material.

---

## 4. Adding the token isn't enough — the intents are the other half

Two separate things must be true for live counts and message text. Render handles the first;
**only you can do the second** in the Discord Developer Portal:

| What | Where | Feeds |
|---|---|---|
| `DISCORD_BOT_TOKEN` in Render | Render → Environment | The gateway connection itself |
| **Server Members** intent | Developer Portal → Bot → Privileged Gateway Intents | member count, bot count, online/offline, join/leave |
| **Message Content** intent | same screen | the *text* of live messages (`MESSAGE_CREATE`) |
| **View Channels** + **Read Message History** perms | invite URL (section 7) | seeing channels; loading history |

Clicking those two intent toggles on is a hard requirement for this dashboard — it is not optional.

---

## 5. ⚠️ Render-specific caveats — read before picking the Free plan

### 5.1 The Free plan sleeps after 15 minutes, and that breaks a *live* dashboard

Render's own docs: a Free web service **spins down after 15 minutes without inbound traffic**
(HTTP requests *and* WebSocket messages from browser clients both count as inbound). The next
request wakes it, which takes **about a minute** while visitors see a Render loading page.

**What that means for this specific app:** a spun-down service has its **process killed**. So:

- The **Discord Gateway WebSocket is dropped** — there is no `PRESENCE_UPDATE`,
  `GUILD_MEMBER_ADD`, or `MESSAGE_CREATE` flowing anywhere.
- All **in-memory state is gone** (this app deliberately keeps everything in memory — no DB).
- On the next visit the service boots, reconnects to the gateway, and rebuilds itself from
  `GUILD_CREATE` + member chunks. Live updates resume — but the dashboard was **dark for the
  whole sleep window**, and messages posted during it are absent from the live view. (Opening a
  channel still backfills history via the REST call, so history isn't lost — only the
  "watched it arrive live" stream.)

In short: **on Free, this is a dashboard that is live when you're looking at it and asleep when
you're not.** For many people that's fine. If you want it *genuinely always live*, use Starter.

### 5.2 The Free plan's monthly hour budget has no headroom here

- Render grants **750 Free instance hours per workspace per calendar month**.
- An always-awake service burns roughly **720–744 hours** (30–31 days × 24h).
- Exceed 750 and **all your Free web services are suspended until the 1st of next month**.
- Spun-down services *don't* consume hours — so a truly idle service is cheap.

One always-on service just fits… with essentially **zero margin** for a second service, a
staging twin, or overlapping deploys. There is no comfortable "keep it awake 24/7 on Free" story.

### 5.3 Also on Free

- **512 MB RAM / 0.1 CPU**, and **cannot scale past one instance**. This app is light (idle
  gateway + SSE), so it fits — but a busy multi-server fleet with large member lists is worth watching.
- **No persistent disk** — irrelevant here, the app writes nothing to disk by design.
- **A keep-alive ping works, but know the cost.** While a browser tab with the SSE stream open
  is connected, that *is* inbound traffic and keeps the service awake on its own. To keep it up
  with nobody watching, ping `https://<your-app>.onrender.com/api/health` every ~10–14 minutes
  from an external cron (e.g. UptimeRobot, cron-job.org). That keeps it live — and consumes
  nearly the full 750-hour budget, which is exactly why Starter is the cleaner answer.

### 5.4 Recommendation

- **Want a real-time dashboard you can leave running?** → **Starter** (~$7/month). No spin-down,
  no cold starts, gateway stays connected, counts stay live around the clock.
- **Want it free, and accept sleep?** → set `plan: free` in `render.yaml` (one line) and expect
  a ~1-minute cold start plus a data gap after idle. Section 2A's Blueprint ships `starter`
  by default precisely to avoid that surprise.

---

## 6. Verify the deploy actually worked

1. In Render, wait for the status to read **Live** (first build ~1–2 min).
2. Open **`https://<your-service-name>.onrender.com`** — the dashboard UI should load.
3. Check the health endpoint:
   **`https://<your-service-name>.onrender.com/api/health`**
   Expect:
   ```json
   { "ok": true, "mode": "bot", "state": "ready", "guilds": 1, "listeners": 1, "uptimeSeconds": 42 }
   ```
   - `mode: "bot"` → the token was picked up. If it says `"demo"`, jump to troubleshooting.
   - `state: "ready"` → the Gateway handshake completed.
   - `guilds: 1` → however many servers your bot is in.
4. Check the data endpoint:
   **`https://<your-service-name>.onrender.com/api/snapshot`**
   Should return your bot's user object plus each server with real `name`, `member_count`,
   `presence_count`, `bot_count`, `offline_count`, and its channels.
5. In the **UI**, confirm the connection label reads **`live`** — not **`live (demo)`**. That single
   label is the fastest honest signal of whether real data is flowing.
6. Click a server → a channel → the chat panel should fill with recent messages.
7. **Give it a moment on first boot:** counts can sit at 0 for a few seconds right after
   `state: "ready"` while `GUILD_CREATE` payloads and member chunks arrive. Not a bug.

Watch it be *live*: keep the page open and post a message in a Discord channel the bot can see —
it should appear in the chat view within a second or two, and the online/member counts should
shift as people come and go.

---

## 7. Troubleshooting — symptom → cause → fix

| Symptom | Likely cause | Fix |
|---|---|---|
| **UI label says `live (demo)`**, `/api/health` shows `"mode":"demo"` | `DISCORD_BOT_TOKEN` missing, blank, or whitespace-wrong — the app silently falls back to the simulator. (Or `DEMO_MODE=1`.) | Render → Environment → set the token (and `DEMO_MODE=0`) → save → rebuild. The app trims the value, so re-paste to be sure. |
| **Bot shows but 0 servers** | Bot hasn't been invited anywhere. | Use the invite URL in section 7.1 on each server. |
| **Server listed, but member count 0 / no online-offline numbers** | **Server Members** privileged intent is OFF — member and presence data is simply not delivered. | Developer Portal → Bot → enable **Server Members** → the app reconnects and repopulates. |
| **Channels list is empty** | Bot lacks **View Channels** in that server. | Re-invite with the permissions in 7.1, or fix the channel's permission overwrites. |
| **Chat view is empty, but counts work** | **Message Content** intent is OFF → `MESSAGE_CREATE` arrives with empty content. | Developer Portal → Bot → enable **Message Content**. |
| **`403` when loading channel history** | Missing **Read Message History**. | Re-invite with `permissions=66560`. The API response includes this exact hint. |
| **Build fails** | Node too old or a lockfile mismatch. | `package.json` needs Node ≥18. Set env `NODE_VERSION=20`. Build command must be `npm install`. |
| **First page load takes ~60s / shows a Render splash** | Free-plan cold start. Expected, not an error. | Wait it out, or move to Starter (section 5). |
| **Service suspended mid-month** | 750 Free instance hours exhausted. | Wait for the 1st, or upgrade to Starter. |
| **`502` right after deploy** | Render's health check passed but the gateway hasn't reached `ready` yet, or the process crashed. | Check **Logs** — look for `[dashboard] Starting in BOT mode` then `state: ready`. A bad token logs a client error. |
| **Android/iOS shows stale data** | Browser cached the SSE stream. | Hard-refresh; the stream sets `Cache-Control: no-cache`. |

---

## 7.1 Invite the bot (do this per server)

Open this URL and pick each server you want monitored (replace nothing — it's your bot's ID):

```
https://discord.com/api/oauth2/authorize?client_id=1546030312620818572&permissions=66560&scope=bot
```

`66560` = **View Channels** + **Read Message History**. Repeat for every server, including
**ReactoSMP** (`756724199627948063`). Servers the bot isn't in will never appear — the bot can
only see what it's a member of.

---

## 8. Remaining manual steps — the short list

1. **Enable both privileged intents** — Developer Portal → your app → **Bot** → *Privileged
   Gateway Intents* → ✅ **Server Members**, ✅ **Message Content**. (Without these: no counts, no message text.)
2. **Invite the bot** to each server you want on the dashboard (URL above). Right now it is only
   in `bot test`.
3. **Rotate the bot token.** 🔴 Your token was pasted into a chat, so it is **exposed and must be
   treated as compromised**: Developer Portal → **Bot** → **Reset Token** → copy the new value →
   update `DISCORD_BOT_TOKEN` in Render (Environment) and in your local `.env` → save → rebuild.
   Resetting invalidates the old token, so do it as soon as setup is verified. It was never
   committed to git.

---

## 9. Quick reference

| | |
|---|---|
| Repo | https://github.com/VenZ9/discord-live-dashboard |
| Blueprint deeplink | `https://dashboard.render.com/blueprint/new?repo=https://github.com/VenZ9/discord-live-dashboard` |
| Service type | Web Service · runtime **Node** |
| Build command | `npm install` |
| Start command | `npm start` (= `node src/server.js`) |
| Health check path | `/api/health` |
| Required env var | `DISCORD_BOT_TOKEN` (never in git) |
| Live stream endpoint | `/api/stream` (SSE) |
| Data endpoint | `/api/snapshot` |
| Port | app reads `PORT`; Render default `10000`, blueprint pins `3000` |
| Free plan | sleeps after 15 min idle · 750 instance hours/mo · 512 MB / 0.1 CPU · 1 instance |
| Recommended plan | **Starter** for a continuously live dashboard |
