# Telegram gateway — client tutorial

For any agent or script that wants to talk to the owner through agent-office's Telegram gateway.
The gateway is a plain HTTP API; you don't need to be written in TypeScript.

## Base URL

```
https://<your-public-host>
```

(Or `http://127.0.0.1:4600` when running on the same machine.)

## Authentication

Every agent endpoint accepts either:
- A signed-in browser session cookie, **or**
- The header `X-Telegram-Gateway-Secret: <secret>` (the shared secret).

The webhook endpoint (`/api/telegram/webhook`) is public but verified by Telegram's `X-Telegram-Bot-Api-Secret-Token`.

## Concepts

- **agent_id**: a unique string identifying you (e.g. `agent-office`, `pm-agent`, `my-script`). Pick one and reuse it.
- **active listener**: the agent that receives the owner's replies by default. Only one at a time.
- **callback_url**: if you have an HTTP server, the gateway POSTs replies to it. Otherwise, poll `/inbox`.
- **inbox**: per-agent queue of replies for agents without a callback URL.

## Quick start (3 steps)

### 1. Subscribe

```bash
curl -X POST -H 'X-Telegram-Gateway-Secret: <secret>' \
  -H 'content-type: application/json' \
  -d '{"agent_id":"my-agent","callback_url":"https://my-host/api/telegram/reply"}' \
  https://<your-public-host>/api/telegram/subscribe
```

Omit `callback_url` if you have no HTTP server (you'll poll instead).

### 2. Become the active listener

```bash
curl -X POST -H 'X-Telegram-Gateway-Secret: <secret>' \
  -H 'content-type: application/json' \
  -d '{"agent_id":"my-agent"}' \
  https://<your-public-host>/api/telegram/activate
```

### 3. Send a message

```bash
curl -X POST -H 'X-Telegram-Gateway-Secret: <secret>' \
  -H 'content-type: application/json' \
  -d '{"text":"Hello from my-agent! Status: all good."}' \
  https://<your-public-host>/api/telegram/send
```

The owner sees it on Telegram and can reply.

## Receiving replies

### Option A — callback (if you have an HTTP server)

Register a `callback_url`. The gateway POSTs:

```json
{
  "agent_id": "my-agent",
  "message": { "id": 123, "from": "<your-chat-id>", "text": "looks good, proceed", "at": 1794120000000 }
}
```

Your endpoint must return 200. Handle the message (e.g. trigger a worker, log, reply).

### Option B — polling (no HTTP server)

```bash
curl "https://<your-public-host>/api/telegram/inbox?agent=my-agent&secret=<secret>"
# → {"messages":[{"id":...,"from":"...","text":"...","at":...}]}
```

Polling drains the inbox (returns and clears). Poll every few seconds.

## TypeScript / JavaScript client

Import `src/server/telegram-client.ts` (or copy it):

```ts
import { TelegramGatewayClient } from './telegram-client';

const tg = new TelegramGatewayClient({
  baseUrl: 'https://<your-public-host>',
  secret: process.env.TELEGRAM_GATEWAY_SECRET!,
  agentId: 'my-agent',
});

await tg.subscribe('https://my-host/api/telegram/reply'); // or tg.subscribe() for polling
await tg.activate();
await tg.send('Hello from my-agent!');

// polling:
const replies = await tg.poll();
for (const m of replies) console.log('reply:', m.text);
```

## Python example

```python
import requests, os
BASE = "https://<your-public-host>"
SECRET = os.environ["TELEGRAM_GATEWAY_SECRET"]

def send(text, markup=None):
    r = requests.post(f"{BASE}/api/telegram/send",
        headers={"X-Telegram-Gateway-Secret": SECRET, "Content-Type": "application/json"},
        json={"text": text, "reply_markup": markup})
    return r.json()

def poll():
    r = requests.get(f"{BASE}/api/telegram/inbox", params={"agent": "my-agent", "secret": SECRET})
    return r.json().get("messages", [])

# send with inline buttons
send("Approve deployment?", {
    "inline_keyboard": [[
        {"text": "Approve", "callback_data": "approve"},
        {"text": "Reject", "callback_data": "reject"},
    ]]
})
```

## Inline keyboards (approval flows)

Send a message with `reply_markup`:

```json
{
  "text": "Deploy to production?",
  "reply_markup": {
    "inline_keyboard": [
      [{"text": "✅ Approve", "callback_data": "approve"}],
      [{"text": "❌ Reject", "callback_data": "reject"}]
    ]
  }
}
```

When the owner taps a button, the `callback_data` string is delivered as a reply message. The text field of the delivered message is the callback data (e.g. `"approve"`).

## Commands the owner can send

| Command | Effect |
|---|---|
| `/start` | Welcome + current active listener |
| `/status` | Active listener + subscribed agents |
| `/agents` (or `/list`) | List subscribed agents |
| `/activate <agent>` | Switch active listener |
| `/agent <name> <text>` | Address a specific agent (overrides active) |
| Tap inline button | Delivers `callback_data` as a message |

## Inline button tap → delivered message

When the owner taps an inline button, Telegram sends a `callback_query`. The gateway converts it to a normal message whose `text` is the button's `callback_data`, and routes it to the active listener. So your reply handler receives `{ "text": "approve" }`.

## Security notes

- The bot token and gateway secret live in `.env` (gitignored). Never commit them.
- Only the owner's Telegram user id (`TELEGRAM_OWNER_CHAT_ID`) may talk to the bot; other users are silently ignored.
- The webhook endpoint verifies Telegram's `X-Telegram-Bot-Api-Secret-Token`.
- Agent endpoints require the gateway secret (or a signed-in session).
- `GET /inbox` accepts the secret via header or `?secret=` query param (for simple polling clients). Prefer the header.

## Cleanup

When your agent shuts down, unsubscribe:

```bash
curl -X POST -H 'X-Telegram-Gateway-Secret: <secret>' \
  -H 'content-type: application/json' \
  -d '{"agent_id":"my-agent"}' \
  https://<your-public-host>/api/telegram/unsubscribe
```

## Full API reference

See `docs/telegram.md`.
