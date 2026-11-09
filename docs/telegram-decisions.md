# Telegram 決策/核准 API（樣板）

給**其他專案**使用的標準做法：專案呼叫 agent-office 的 API → agent-office 發送 Telegram 訊息給 owner（你）→ 你在 Telegram 點按鈕（批准/駁回/單選/多選）→ 結果回傳給專案。

這是 agent-office 共用 Telegram gateway 之上的高階 API，類似 `dpms-cosmo-monitor` 這類專案整合的模式：專案只要能發 HTTP 請求（或收 callback），就能取得你的決策。

> 相關文件：[`docs/telegram.md`](./telegram.md)（gateway 設定）、[`docs/telegram-client.md`](./telegram-client.md)（低階 send/subscribe/poll）。

## 能力

| 類型 | `type` | 說明 | 回傳 |
|---|---|---|---|
| 批准/駁回 | `approve` | 兩個按鈕（可自訂文字） | `action: approve/reject`, `value` |
| 單選 | `pick` | 多個選項選 1 個 | `action: pick`, `value: <option.key>` |
| 多選後送出 | `multi` | 勾選多項 → 送出/取消（會即時更新訊息按鈕）；支援 `__all__` 全選切換 | `action: submit/cancel`, `selected: [...]`（實際選取項，不含 `__all__`） |

所有請求都帶 `decision_id`（短 id）與可選的 `correlation_id`/`metadata`（原樣回傳），方便對應你專案內的單據/任務。

## 前置條件

1. agent-office 的 Telegram gateway 已設定（`.env`：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_WEBHOOK_SECRET`、`TELEGRAM_OWNER_CHAT_ID`、`TELEGRAM_GATEWAY_SECRET`），且 webhook 已註冊（見 `docs/telegram.md`）。
2. 呼叫方知道：
   - `BASE_URL`：例如 `https://agent-office.lawrence-dev.duckdns.org`（或內網 `http://127.0.0.1:<port>`）
   - `TELEGRAM_GATEWAY_SECRET`：放在 `X-Telegram-Gateway-Secret` header（**不要寫進 git**）
   - `agent_id`：你的專案識別名（建議固定且唯一，如 `dpms-v2`、`my-project`）

## API 總覽

所有端點都需要授權：`X-Telegram-Gateway-Secret: <secret>`（或已登入的瀏覽器 session）。

| 方法 | 路徑 | 用途 |
|---|---|---|
| `POST` | `/api/telegram/decisions` | 建立並發送決策請求 |
| `GET` | `/api/telegram/decisions?id=<decision_id>` | 查詢單筆結果（輪詢用） |
| `GET` | `/api/telegram/decisions?agent=<agent_id>` | 列出某 agent 的決策 |
| `POST` | `/api/telegram/decisions/<id>/cancel` | 取消待決策 |
| `POST` | `/api/telegram/edit` | （進階）編輯訊息按鈕/文字，gateway 原語 |

## 1) 建立決策：`POST /api/telegram/decisions`

### 批准/駁回（approve）

```bash
curl -sS -X POST "$BASE_URL/api/telegram/decisions" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Gateway-Secret: $SECRET" \
  -d '{
    "agent_id": "my-project",
    "type": "approve",
    "text": "是否部署到 production？",
    "description": "版本 v1.2.3，含 DB migration（已備份驗證）",
    "callback_url": "https://my-project.example.com/hooks/telegram-decision",
    "correlation_id": "deploy-2026-0001",
    "metadata": {"env": "production", "version": "1.2.3"},
    "timeout_sec": 3600
  }'
```

成功回應：
```json
{ "ok": true, "decision_id": "k3mz9q2x1a", "message_id": 123, "chat_id": 145613399 }
```

### 單選（pick）

```bash
curl -sS -X POST "$BASE_URL/api/telegram/decisions" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Gateway-Secret: $SECRET" \
  -d '{
    "agent_id": "my-project",
    "type": "pick",
    "text": "請選擇要執行的方案",
    "options": [
      {"key": "A", "label": "方案 A：快速修補"},
      {"key": "B", "label": "方案 B：重構"},
      {"key": "C", "label": "方案 C：暫緩"}
    ],
    "callback_url": "https://my-project.example.com/hooks/telegram-decision",
    "correlation_id": "issue-42"
  }'
```

### 多選後送出（multi）

```bash
curl -sS -X POST "$BASE_URL/api/telegram/decisions" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Gateway-Secret: $SECRET" \
  -d '{
    "agent_id": "my-project",
    "type": "multi",
    "text": "請選擇本次要處理的項目（可多選）",
    "options": [
      {"key": "lint", "label": "Lint"},
      {"key": "test", "label": "測試"},
      {"key": "build", "label": "建置"},
      {"key": "deploy", "label": "部署"}
    ],
    "submit_label": "✅ 開始執行",
    "cancel_label": "取消",
    "callback_url": "https://my-project.example.com/hooks/telegram-decision",
    "correlation_id": "pipeline-77"
  }'
```

owner 點選項目時，訊息按鈕會即時切換 `☑/☐`；按「送出」才會回傳結果。

若要提供「全選/取消全選」，可加入特殊選項 `{ "key": "__all__", "label": "全選" }`（key 固定為 `__all__`）。點擊 `__all__` 會切換所有非 `__all__` 選項的勾選狀態；送出時 `selected` 只包含實際選取的選項 key（不包含 `__all__`）。

### 欄位說明

- `agent_id`（必填）：呼叫方識別名。
- `type`（必填）：`approve` | `pick` | `multi`。
- `text`（必填）：顯示給 owner 的主文案。
- `description`：補充說明。
- `options`：`pick/multi` 必填，`approve` 可省略。每項 `{ "key": "...", "label": "..." }`；`key` 建議短且穩定（`[A-Za-z0-9_.-]`，≤24 字元），結果會回傳 `key`。最多 12 項。
- `callback_url`：決策完成/取消/逾時後，agent-office 會 `POST` 結果 JSON 到此 URL（並帶 `x-telegram-gateway-secret`）。若專案無法收 callback，可改用輪詢。
- `correlation_id` / `metadata`：原樣回傳，供專案對帳。
- `timeout_sec`：預設 `86400`（24 小時）；`0` 表示不逾時；最小 30 秒。

## 2) 結果回傳（callback_url）

agent-office 會 POST：
```json
{
  "type": "telegram.decision",
  "decision_id": "k3mz9q2x1a",
  "agent_id": "my-project",
  "correlation_id": "deploy-2026-0001",
  "metadata": {"env": "production", "version": "1.2.3"},
  "state": "resolved",
  "action": "approve",
  "value": "approve",
  "selected": [],
  "raw": "d|k3mz9q2x1a|ok|approve",
  "from": "145613399",
  "at": 1794226088002,
  "message_id": 123,
  "chat_id": 145613399
}
```

重點欄位：
- `state`: `resolved` | `cancelled` | `expired`
- `approve`: `action/value` 為 `approve` 或 `reject`
- `pick`: `action = pick`，`value = <option.key>`
- `multi` 送出：`action = submit`，`selected = ["lint","test"]`
- `multi` 取消 / 使用者取消：`state = cancelled`

> callback 失敗（專案離線）時，結果仍保留一段時間，可用輪詢補撈。

## 3) 輪詢：`GET /api/telegram/decisions?id=<decision_id>`

```bash
curl -sS "$BASE_URL/api/telegram/decisions?id=k3mz9q2x1a" \
  -H "X-Telegram-Gateway-Secret: $SECRET"
```

待決策時 `state` 為 `pending`；完成後回傳同結構的結果。可依 `state !== 'pending'` 結束輪詢。

## Node.js 樣板（HTTP API，最通用）

```js
// telegram-decision-template.mjs
// 用法：BASE_URL / TELEGRAM_GATEWAY_SECRET / CALLBACK_URL 由環境變數提供（勿寫進 git）

const BASE_URL = process.env.AGENT_OFFICE_TELEGRAM_URL;       // e.g. https://agent-office...
const SECRET   = process.env.TELEGRAM_GATEWAY_SECRET;
const AGENT_ID = process.env.AGENT_ID || 'my-project';
const CALLBACK_URL = process.env.DECISION_CALLBACK_URL;       // 可選，公開可達的 https URL

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Gateway-Secret': SECRET },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

export async function askApprove({ text, description, correlation_id, metadata, timeout_sec = 3600 }) {
  return api('/api/telegram/decisions', {
    method: 'POST',
    body: { agent_id: AGENT_ID, type: 'approve', text, description, correlation_id, metadata, timeout_sec, callback_url: CALLBACK_URL },
  }); // => { ok, decision_id, ... }
}

export async function askPick({ text, options, description, correlation_id, metadata, timeout_sec = 3600 }) {
  return api('/api/telegram/decisions', {
    method: 'POST',
    body: { agent_id: AGENT_ID, type: 'pick', text, options, description, correlation_id, metadata, timeout_sec, callback_url: CALLBACK_URL },
  });
}

export async function askMulti({ text, options, description, correlation_id, metadata, timeout_sec = 3600 }) {
  return api('/api/telegram/decisions', {
    method: 'POST',
    body: { agent_id: AGENT_ID, type: 'multi', text, options, description, correlation_id, metadata, timeout_sec, callback_url: CALLBACK_URL },
  });
}

export async function waitDecision(decision_id, { intervalMs = 3000, timeoutMs = 3600_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await api(`/api/telegram/decisions?id=${encodeURIComponent(decision_id)}`);
    if (r && r.state && r.state !== 'pending') return r;
    await new Promise(res => setTimeout(res, intervalMs));
  }
  return { ok: false, error: 'poll timeout', decision_id };
}

// --- 範例：核准後才繼續 ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const created = await askApprove({
    text: '是否執行 DB migration？',
    description: '目標：staging\n變更：add index on orders.created_at',
    correlation_id: `mig-${Date.now()}`,
    metadata: { step: 'migrate' },
  });
  if (!created.ok) throw new Error(created.error);
  console.log('已送出，decision_id=', created.decision_id);
  const result = await waitDecision(created.decision_id);
  console.log('結果=', result);
  if (result.action !== 'approve') process.exit(2);
  console.log('已批准，繼續執行...');
}
```

## Node.js 樣板（使用 `TelegramGatewayClient`，agent-office 內/TS 專案）

```ts
import { TelegramGatewayClient } from 'agent-office/src/server/telegram-client'; // 或複製該檔

const tg = new TelegramGatewayClient({
  baseUrl: process.env.AGENT_OFFICE_TELEGRAM_URL!,
  secret: process.env.TELEGRAM_GATEWAY_SECRET!,
  agentId: 'my-project',
});

const created = await tg.askApprove({
  text: '是否核准發版？',
  callback_url: process.env.DECISION_CALLBACK_URL,
  correlation_id: 'release-42',
});
// 輪詢：await tg.getDecision(created.decision_id)
```

## Python 樣板（HTTP API）

```python
import os, time, requests

BASE = os.environ["AGENT_OFFICE_TELEGRAM_URL"]
SECRET = os.environ["TELEGRAM_GATEWAY_SECRET"]
AGENT = os.environ.get("AGENT_ID", "my-project")
H = {"Content-Type": "application/json", "X-Telegram-Gateway-Secret": SECRET}

def ask_approve(text, description=None, correlation_id=None, metadata=None, callback_url=None):
    r = requests.post(f"{BASE}/api/telegram/decisions", headers=H, json={
        "agent_id": AGENT, "type": "approve", "text": text, "description": description,
        "correlation_id": correlation_id, "metadata": metadata, "callback_url": callback_url,
    }, timeout=30)
    return r.json()

def wait_decision(decision_id, interval=3, timeout=3600):
    end = time.time() + timeout
    while time.time() < end:
        r = requests.get(f"{BASE}/api/telegram/decisions", headers=H, params={"id": decision_id}, timeout=30).json()
        if r.get("state") and r["state"] != "pending":
            return r
        time.sleep(interval)
    return {"ok": False, "error": "poll timeout"}
```

## 接收 callback（`callback_url` 模式）

你的專案提供一個 `POST` endpoint（需可被 agent-office 存取，通常是 https）。收到 body 即上面的「結果回傳」JSON。

```js
// Express/任意 HTTP server 範例
app.post('/hooks/telegram-decision', (req, res) => {
  const secret = req.header('x-telegram-gateway-secret');
  if (process.env.TELEGRAM_GATEWAY_SECRET && secret !== process.env.TELEGRAM_GATEWAY_SECRET) return res.status(401).end();
  const r = req.body; // { type:'telegram.decision', decision_id, action, value, selected, correlation_id, metadata, state }
  if (r.correlation_id === myPendingId) {
    if (r.action === 'approve') proceed();
    else if (r.action === 'reject') abort();
  }
  res.json({ ok: true });
});
```

驗證 `x-telegram-gateway-secret` 可避免偽造 callback（建議做）。

## 設計建議（務必遵守）

- **不要硬編碼秘密**：`TELEGRAM_GATEWAY_SECRET`、bot token 只放環境變數/秘密管理，不進 git、不寫進 log。
- **帶 `correlation_id`**：把專案內的 request id / issue / deploy id 放進去，回傳時原樣帶回，避免對錯單。
- **冪等處理**：callback 可能因網路重送而重複；用 `decision_id`/`correlation_id` 做去重，重複結果不重複執行副作用。
- **逾時與降級**：設合理 `timeout_sec`；逾時狀態為 `expired`。若專案沒有公開 `callback_url`，用輪詢。
- **`options[].key` 保持穩定且短**：結果依 `key` 分支（不要依顯示文字分支）；`key` 會進 Telegram `callback_data`（受 64 bytes 限制，API 已做基本處理）。
- **多選（multi）** 是「切換再送出」：需要 owner 按送出才會 resolve；中途切換由 agent-office 即時更新按鈕。可加入 `{ "key": "__all__", "label": "全選" }` 提供全選切換；`__all__` 是 UI 控制鍵，結果 `selected` 會展開為實際選取項。
- **破壞性操作**：批准/駁回只代表「owner 同意/拒絕」，專案端仍應在執行前做自身驗證（備份/權限/環境），不要把 Telegram 按鈕當成唯一安全閘門。

## 低階 gateway 原語（進階）

一般情況用 `/api/telegram/decisions` 即可。若你要完全自管狀態，可用低階 API：
- `POST /api/telegram/send`（可帶 `reply_markup`，回傳含 `result.message_id`）
- `POST /api/telegram/edit`（`{ chat_id?, message_id, text?, reply_markup? }`，多選切換用）
- callback_data 回收：透過 subscribe+callback 或 inbox/poll（見 `docs/telegram-client.md`）

> 決策 API 內部已使用 `d|<id>|<act>|<val>` 格式並自動攔截處理；自管低階按鈕時請避免與 `d|` 前綴衝突。
