// Telegram 決策/核准 API：其他專案可透過 agent-office 發送「批准/駁回」或「選項」給 owner，
// owner 在 Telegram 點擊按鈕後，結果會回傳給呼叫方（callback_url 或輪詢）。
// callback_data 格式（64 bytes 內）：d|<id>|<act>|<val>
// act: ok=批准, no=駁回, p=單選, t=多選切換, s=多選送出, c=取消

import { randomBytes } from 'node:crypto';
import type { TelegramGateway } from './telegram.js';

export type DecisionType = 'approve' | 'pick' | 'multi';
export type DecisionState = 'pending' | 'resolved' | 'cancelled' | 'expired';

export interface DecisionOption { key: string; label: string }
export interface DecisionRequest {
  agent_id: string;
  callback_url?: string;
  type: DecisionType;
  /** 主標題/問題（會顯示在 Telegram 訊息） */
  text: string;
  /** 補充說明 */
  description?: string;
  /** pick/multi 的選項；approve 可省略（預設 批准/駁回） */
  options?: DecisionOption[];
  /** 多選時的送出/取消按鈕文字 */
  submit_label?: string;
  cancel_label?: string;
  /** 批准/駁回按鈕文字 */
  approve_label?: string;
  reject_label?: string;
  /** 逾時秒數（預設 86400=24h，0 表示不逾時） */
  timeout_sec?: number;
  /** 呼叫方自訂關聯 id，原樣回傳 */
  correlation_id?: string;
  /** 呼叫方自訂資料，原樣回傳 */
  metadata?: unknown;
}

export interface DecisionResult {
  type: 'telegram.decision';
  decision_id: string;
  agent_id: string;
  correlation_id?: string;
  metadata?: unknown;
  state: DecisionState;
  action?: string;
  /** pick 的單一值；approve 為 "approve"/"reject" */
  value?: string;
  /** multi 的已選值 */
  selected?: string[];
  /** owner 點擊的原始 callback_data */
  raw?: string;
  from?: string;
  at: number;
  message_id?: number;
  chat_id?: string | number;
}

interface Pending {
  id: string;
  req: DecisionRequest;
  state: DecisionState;
  createdAt: number;
  expiresAt: number | null;
  messageId?: number;
  chatId?: string | number;
  selected: Set<string>;
  result?: DecisionResult;
}

const ID_RE = /^[a-z0-9]{6,16}$/;
const OPT_KEY_RE = /^[A-Za-z0-9_\-.]{1,24}$/;

function shortId(): string { return randomBytes(6).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 10) || randomBytes(5).toString('hex'); }
function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

export class TelegramDecisions {
  private pending = new Map<string, Pending>();
  private sweep: NodeJS.Timeout;

  constructor(private readonly tg: TelegramGateway) {
    this.tg.onCallbackData((data, from, updateId) => this.handleCallback(data, from, updateId));
    this.sweep = setInterval(() => this.expire(), 60_000);
    this.sweep.unref?.();
  }

  private expire() {
    const now = Date.now();
    for (const [id, p] of this.pending.entries()) {
      if (p.state === 'pending' && p.expiresAt && now >= p.expiresAt) {
        this.resolve(p, { state: 'expired', action: 'expired', at: now });
      }
      // 已完成的決策保留 24 小時供輪詢，之後清除
      if (p.state !== 'pending' && now - (p.result?.at ?? p.createdAt) > 24 * 3600_000) this.pending.delete(id);
    }
  }

  private normalizeOptions(req: DecisionRequest): { ok: true; options: DecisionOption[] } | { ok: false; error: string } {
    if (req.type === 'approve') {
      const options = req.options?.length ? req.options : [
        { key: 'approve', label: req.approve_label || '✅ 批准' },
        { key: 'reject', label: req.reject_label || '❌ 駁回' },
      ];
      if (options.length < 1 || options.length > 2) return { ok: false, error: 'approve 類型最多 2 個選項' };
      return { ok: true, options };
    }
    const opts = req.options ?? [];
    if (opts.length < 1) return { ok: false, error: 'pick/multi 需要 options' };
    if (opts.length > 12) return { ok: false, error: '最多 12 個選項' };
    const seen = new Set<string>();
    for (const o of opts) {
      if (!o || !OPT_KEY_RE.test(String(o.key))) return { ok: false, error: `選項 key 不合法: ${o?.key}` };
      if (!String(o.label || '').trim()) return { ok: false, error: `選項 ${o.key} 缺少 label` };
      if (seen.has(o.key)) return { ok: false, error: `選項 key 重複: ${o.key}` };
      seen.add(o.key);
    }
    return { ok: true, options: opts.map(o => ({ key: o.key, label: clip(String(o.label), 48) })) };
  }

  private encode(id: string, act: string, val: string): string {
    // d|<id>|<act>|<val>，Telegram callback_data 上限 64 bytes
    const data = `d|${id}|${act}|${val}`;
    return data.length > 64 ? `d|${id}|${act}|${val.slice(0, 64 - (`d|${id}|${act}|`).length)}` : data;
  }

  private isAllKey(key: string): boolean { return key === '__all__'; }

  private realOptionKeys(options: DecisionOption[]): string[] {
    return options.map(o => o.key).filter(k => !this.isAllKey(k));
  }

  private allSelected(p: Pending, options: DecisionOption[]): boolean {
    const real = this.realOptionKeys(options);
    return real.length > 0 && real.every(k => p.selected.has(k));
  }

  private markup(p: Pending, options: DecisionOption[]): unknown {
    if (p.req.type === 'approve' || p.req.type === 'pick') {
      const row = options.map(o => ({ text: o.label, callback_data: this.encode(p.id, p.req.type === 'approve' ? (o.key === 'reject' ? 'no' : 'ok') : 'p', o.key) }));
      // Telegram 每列建議不超過 3-4 個；簡單分列
      const rows: any[] = [];
      for (let i = 0; i < row.length; i += 3) rows.push(row.slice(i, i + 3));
      return { inline_keyboard: rows };
    }
    // multi: toggle + submit/cancel（支援 __all__ 全選切換）
    const allOn = this.allSelected(p, options);
    const rows: any[] = options.map(o => ([{
      text: `${(this.isAllKey(o.key) ? allOn : p.selected.has(o.key)) ? '☑' : '☐'} ${o.label}`,
      callback_data: this.encode(p.id, 't', o.key),
    }]));
    rows.push([
      { text: p.req.submit_label || '✅ 送出', callback_data: this.encode(p.id, 's', '_') },
      { text: p.req.cancel_label || '取消', callback_data: this.encode(p.id, 'c', '_') },
    ]);
    return { inline_keyboard: rows };
  }

  private text(p: Pending): string {
    const head = p.req.type === 'approve' ? '【需要核准】' : p.req.type === 'multi' ? '【多選】' : '【請選擇】';
    const parts = [`${head} ${p.req.text}`];
    if (p.req.description) parts.push('', p.req.description);
    parts.push('', `來自: ${p.req.agent_id}`, `決策ID: ${p.id}`);
    return clip(parts.join('\n'), 3800);
  }

  async request(req: DecisionRequest): Promise<{ ok: true; decision_id: string; message_id?: number; chat_id?: string | number } | { ok: false; error: string }> {
    if (!this.tg.configured()) return { ok: false, error: 'Telegram 未設定 (TELEGRAM_BOT_TOKEN)' };
    if (!req || typeof req.agent_id !== 'string' || !req.agent_id.trim()) return { ok: false, error: 'agent_id 必填' };
    if (req.type !== 'approve' && req.type !== 'pick' && req.type !== 'multi') return { ok: false, error: 'type 必須是 approve / pick / multi' };
    if (typeof req.text !== 'string' || !req.text.trim()) return { ok: false, error: 'text 必填' };
    if (req.callback_url && !/^https?:\/\//i.test(req.callback_url)) return { ok: false, error: 'callback_url 必須是 http(s) URL' };
    const norm = this.normalizeOptions(req);
    if (!norm.ok) return norm;
    const id = shortId();
    const now = Date.now();
    const timeout = req.timeout_sec === 0 ? 0 : Math.max(30, Math.min(7 * 86400, req.timeout_sec ?? 86400));
    const p: Pending = { id, req: { ...req, agent_id: req.agent_id.trim(), text: String(req.text).trim() }, state: 'pending', createdAt: now, expiresAt: timeout ? now + timeout * 1000 : null, selected: new Set() };
    this.pending.set(id, p);
    const sent = await this.tg.send(this.text(p), undefined, this.markup(p, norm.options));
    if (!sent.ok) { this.pending.delete(id); return { ok: false, error: sent.error || '發送失敗' }; }
    const result: any = sent.result;
    p.messageId = result?.message_id;
    p.chatId = result?.chat?.id ?? this.tg.ownerChatId();
    return { ok: true, decision_id: id, message_id: p.messageId, chat_id: p.chatId };
  }

  get(id: string): DecisionResult | { ok: false; error: string } {
    const p = this.pending.get(id);
    if (!p) return { ok: false, error: '找不到 decision_id' };
    return p.result ?? this.baseResult(p, { state: p.state, at: Date.now() });
  }

  list(agentId?: string): DecisionResult[] {
    const out: DecisionResult[] = [];
    for (const p of this.pending.values()) {
      if (agentId && p.req.agent_id !== agentId) continue;
      out.push(p.result ?? this.baseResult(p, { state: p.state, at: Date.now() }));
    }
    return out.sort((a, b) => b.at - a.at).slice(0, 200);
  }

  cancel(id: string): { ok: boolean; error?: string } {
    const p = this.pending.get(id);
    if (!p) return { ok: false, error: '找不到 decision_id' };
    if (p.state !== 'pending') return { ok: false, error: `目前狀態為 ${p.state}` };
    this.resolve(p, { state: 'cancelled', action: 'cancel', at: Date.now() });
    return { ok: true };
  }

  private baseResult(p: Pending, patch: Partial<DecisionResult>): DecisionResult {
    return { type: 'telegram.decision', decision_id: p.id, agent_id: p.req.agent_id, correlation_id: p.req.correlation_id, metadata: p.req.metadata, state: p.state, at: Date.now(), message_id: p.messageId, chat_id: p.chatId, ...patch };
  }

  private async resolve(p: Pending, patch: Partial<DecisionResult>) {
    if (p.state !== 'pending') return;
    p.state = (patch.state as DecisionState) || 'resolved';
    p.result = this.baseResult(p, patch);
    // 多選送出/完成後，更新訊息顯示結果（移除按鈕）
    if (p.messageId && p.chatId && (patch.action === 'submit' || patch.action === 'cancel' || patch.action === 'expired' || p.req.type !== 'multi' || p.state !== 'pending')) {
      const summary = this.summary(p);
      void this.tg.editMessageText(p.chatId, p.messageId, summary).catch(() => {});
    }
    if (p.req.callback_url) {
      void fetch(p.req.callback_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-gateway-secret': this.tg.gatewaySecret() ?? '' },
        body: JSON.stringify(p.result),
      }).catch(() => { /* 呼叫方離線：結果仍可輪詢 */ });
    }
  }

  private summary(p: Pending): string {
    const r = p.result;
    const head = r?.state === 'cancelled' ? '【已取消】' : r?.state === 'expired' ? '【已逾時】' : '【已完成】';
    let detail = '';
    if (r?.action === 'approve' || r?.value === 'approve') detail = '結果：✅ 批准';
    else if (r?.action === 'reject' || r?.value === 'reject') detail = '結果：❌ 駁回';
    else if (r?.selected?.length) detail = `結果：${r.selected.join(', ')}`;
    else if (r?.value) detail = `結果：${r.value}`;
    return clip([`${head} ${p.req.text}`, detail, `決策ID: ${p.id} · 來源: ${p.req.agent_id}`].filter(Boolean).join('\n'), 3800);
  }

  private parse(data: string): { id: string; act: string; val: string } | null {
    if (!data.startsWith('d|')) return null;
    const [, id, act, ...rest] = data.split('|');
    if (!id || !act) return null;
    return { id, act, val: rest.join('|') };
  }

  private async handleCallback(data: string, from: string, _updateId: number): Promise<boolean> {
    const m = this.parse(data);
    if (!m) return false;
    const p = this.pending.get(m.id);
    if (!p) return true; // d| 決策格式但找不到/已清除：吞掉，避免洩漏到一般對話
    if (p.state !== 'pending') return true; // 已完成，吞掉重複點擊
    if (p.expiresAt && Date.now() >= p.expiresAt) { this.resolve(p, { state: 'expired', action: 'expired', at: Date.now(), raw: data, from }); return true; }

    if (p.req.type === 'multi') {
      if (m.act === 't') {
        if (this.isAllKey(m.val)) {
          const norm = this.normalizeOptions(p.req);
          if (norm.ok) {
            const real = this.realOptionKeys(norm.options);
            const allOn = real.length > 0 && real.every(k => p.selected.has(k));
            if (allOn) for (const k of real) p.selected.delete(k);
            else for (const k of real) p.selected.add(k);
          }
        } else if (p.selected.has(m.val)) p.selected.delete(m.val); else p.selected.add(m.val);
        if (p.messageId && p.chatId) {
          const norm = this.normalizeOptions(p.req);
          if (norm.ok) void this.tg.editMessageReplyMarkup(p.chatId, p.messageId, this.markup(p, norm.options)).catch(() => {});
        }
        return true;
      }
      if (m.act === 's') {
        const selected = [...p.selected].filter(k => !this.isAllKey(k));
        this.resolve(p, { state: 'resolved', action: 'submit', selected, raw: data, from, at: Date.now() });
        return true;
      }
      if (m.act === 'c') {
        this.resolve(p, { state: 'cancelled', action: 'cancel', raw: data, from, at: Date.now() });
        return true;
      }
    }

    // approve/pick
    if (m.act === 'ok' || m.act === 'approve') { this.resolve(p, { state: 'resolved', action: 'approve', value: m.val || 'approve', raw: data, from, at: Date.now() }); return true; }
    if (m.act === 'no' || m.act === 'reject') { this.resolve(p, { state: 'resolved', action: 'reject', value: m.val || 'reject', raw: data, from, at: Date.now() }); return true; }
    if (m.act === 'p') { this.resolve(p, { state: 'resolved', action: 'pick', value: m.val, raw: data, from, at: Date.now() }); return true; }
    if (m.act === 'c') { this.resolve(p, { state: 'cancelled', action: 'cancel', raw: data, from, at: Date.now() }); return true; }
    return true;
  }
}
