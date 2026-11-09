# Telegram channel (shared tool)

agent-office hosts a small Telegram gateway that any project can use to notify the owner and
receive their replies. One bot serves every project; the owner talks to it from anywhere.

## Configuration (environment)

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Secret Telegram echoes in `X-Telegram-Bot-Api-Secret-Token` |
| `TELEGRAM_OWNER_CHAT_ID` | The owner's Telegram user id (only this user may talk to the bot) |
| `TELEGRAM_GATEWAY_SECRET` | Shared secret between the gateway and agents |
| `TELEGRAM_WEBHOOK_URL` | Public URL Telegram posts updates to (e.g. `https://host/api/telegram/webhook`) |

If `TELEGRAM_BOT_TOKEN` is unset the gateway is disabled and the office starts normally.

## One-time setup

```
curl -X POST -H 'X-Telegram-Gateway-Secret: <secret>' \
  -H 'content-type: application/json' \
  -d '{"url":"https://<host>/api/telegram/webhook"}' \
  https://<host>/api/telegram/setup
```

## HTTP API

All agent endpoints accept either a signed-in browser session or the `X-Telegram-Gateway-Secret` header.

- `POST /api/telegram/send` `{ text, chat_id?, reply_markup? }` → send to owner (or a chat).
- `POST /api/telegram/edit` `{ chat_id?, message_id, text?, reply_markup? }` → edit a message / inline keyboard.
- `POST /api/telegram/subscribe` `{ agent_id, callback_url? }` → register a listener.
- `POST /api/telegram/unsubscribe` `{ agent_id }`
- `POST /api/telegram/activate` `{ agent_id }` → make it the active listener.
- `GET  /api/telegram/inbox?agent=<id>&secret=<secret>` → poll pending replies (drains).
- `GET  /api/telegram/status` → configured, active, subscriptions.
- `POST /api/telegram/webhook` (public) → Telegram update receiver.
- **決策/核准 API（推薦給其他專案）**：見 [`docs/telegram-decisions.md`](./telegram-decisions.md)（`/api/telegram/decisions`，支援 批准/駁回、單選、多選後送出，含 callback 回傳與輪詢）。

## Receiving replies

- **Callback (preferred)**: pass `callback_url` to `/subscribe`; the gateway POSTs `{ agent_id, message }` to it.
- **Polling (no HTTP server)**: call `/inbox` on a schedule.

## Commands the owner can send in Telegram

- `/start`, `/status`, `/agents` (`/list`)
- `/activate <agent>` — switch the active listener
- `/agent <name> <text>` — address a specific agent
- Tap an inline button — its `callback_data` is delivered as a message.

## Clients

- TypeScript/JS: `src/server/telegram-client.ts` (`TelegramGatewayClient`).
- Other languages: call the HTTP API directly (curl examples above). All payloads are JSON.
