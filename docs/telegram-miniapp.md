# Telegram Mini App — feasibility

A Telegram Mini App (TMA) is a web page loaded inside Telegram's WebView, opened from a bot
button or menu. This note evaluates using one for agent-office so the owner can browse the
office from their phone.

## Verdict: feasible, with a medium amount of work and one important caveat.

### What fits well

- **Public URL already exists**: `https://<your-public-host>` (basic_auth + webhook exemption).
- **A 2D view exists**: `/lite` is the office without 3D — workers, terminals, boards, queue. It is
  the right surface for a phone. The 3D view is too heavy for a mobile WebView.
- **Real-time works**: the office uses WebSocket; Telegram WebView supports it.
- **Bundle size**: main bundle ~1.5 MB; Telegram's Mini App limit is 10 MB.
- **Telegram provides identity**: `window.Telegram.WebApp.initData` is a signed payload containing
  the user's id/username. The backend can verify it with the bot token and auto-sign-in, so the
  owner never types the office password on their phone.

### What does not fit / needs care

1. **Basic auth blocks the Mini App.** Telegram's WebView cannot send an HTTP Basic credential
   reliably, and the owner would have to type `admin / agent-office-trial` into a browser prompt
   inside Telegram. The Mini App path must be **exempt from basic_auth** (like `/api/telegram/webhook`),
   and authentication must happen via Telegram `initData` instead.
2. **Auto-login.** The office currently requires a password + session cookie. A TMA needs a
   backend endpoint that verifies `initData` (HMAC-SHA256 with the bot token) and issues a session
   cookie for the verified Telegram user. The owner's Telegram id is already the
   allowlisted owner, so verification is straightforward.
3. **Mobile UX.** `/lite` was designed for desktop browsers. Safe areas, viewport height
   (`100vh` vs Telegram's `viewportHeight`), and the bottom nav bar need adjustment.
   Telegram's `WebApp.expand()` / `WebApp.disableVerticalSwipes()` help.
4. **Performance.** Even `/lite` pulls Three.js-adjacent modules? No — `/lite` imports no Three.js
   (enforced by `tests/client-structure.test.ts`). But it still imports a lot of UI code. Acceptable
   on modern phones, marginal on old ones.
5. **WebSocket reconnects** inside Telegram's WebView can be flaky when the app is backgrounded.
   The office already handles reconnect; should be fine.

### Recommended architecture

```
Telegram bot
  └─ menu button / inline button → opens Mini App URL
        https://<your-public-host>/miniapp
              │
              ├─ static assets (exempt from basic_auth)
              └─ Telegram WebApp SDK → passes initData to backend
                    │
                    └─ POST /api/telegram/miniapp-auth { initData }
                          → verify HMAC with bot token
                          → if user id == TELEGRAM_OWNER_CHAT_ID → issue session cookie
                          → redirect to /lite?telegram=1
```

### Changes needed (rough estimate)

| # | Work | Size |
|---|---|---|
| 1 | Add `/miniapp` (or `/lite?telegram=1`) to `auth_exempt_paths` in `public-sites.yaml` | small |
| 2 | Backend: `POST /api/telegram/miniapp-auth` verifying `initData`, issuing session | medium |
| 3 | Frontend: include Telegram WebApp SDK in `/lite` entry, call `expand()`, pass `initData` | small |
| 4 | Auto-login flow in the office (skip password screen when Telegram session present) | medium |
| 5 | Mobile CSS tweaks (safe areas, viewport) | small |
| 6 | Bot menu button / inline button to open the Mini App | tiny |

### Risks

- **Security**: `initData` verification must be done server-side with the bot token. Never trust
  the client. Replay protection via `auth_date` (reject if older than ~1 hour).
- **Basic auth exemption** widens the attack surface slightly; the exemption must be limited to
  `/miniapp` and `/api/telegram/miniapp-auth`, not the whole `/api`.
- **Session lifetime**: Telegram sessions should be short-lived and tied to the verified user.

### Not recommended

- Running the **3D view** inside Telegram. Mobile GPUs and battery make this a poor experience;
  `/lite` is the right surface.
- Exposing the office **without any auth**. Even with Telegram identity, keep the owner check.

### Next step

If you want to proceed, I can implement steps 1–4 as a first pass (Mini App auth + `/lite` adaptation),
testable on a phone via the public URL. Otherwise this stays a feasibility note.