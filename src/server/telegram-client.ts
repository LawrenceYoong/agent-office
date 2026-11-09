// A tiny client for the Telegram gateway (src/server/telegram.ts). Other projects can copy this
// file or call the HTTP API directly (see docs/telegram.md). All secrets are passed in, never stored here.
export interface TelegramClientOptions {
  /** Base URL of the gateway, e.g. https://office.example.com */
  baseUrl: string;
  /** Shared secret (X-Telegram-Gateway-Secret). */
  secret?: string;
  /** This agent's id. */
  agentId: string;
}

export interface TelegramMessage {
  id: number;
  from: string;
  text: string;
  at: number;
}

export class TelegramGatewayClient {
  constructor(private readonly opts: TelegramClientOptions) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.secret) h['x-telegram-gateway-secret'] = this.opts.secret;
    return h;
  }

  private url(path: string): string {
    return this.opts.baseUrl.replace(/\/$/, '') + path;
  }

  /** Send a message to the owner. */
  async send(text: string, replyMarkup?: unknown): Promise<{ ok: boolean; error?: string; result?: any }> {
    const r = await fetch(this.url('/api/telegram/send'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ text, reply_markup: replyMarkup }),
    });
    const j = (await r.json().catch(() => ({}))) as any;
    return { ok: !!j.ok, error: j.error, result: j.result };
  }

  /** Edit an inline keyboard or message text. */
  async edit(messageId: number, opts: { text?: string; reply_markup?: unknown; chat_id?: string | number }): Promise<{ ok: boolean; error?: string }> {
    const r = await fetch(this.url('/api/telegram/edit'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ message_id: messageId, ...opts }),
    });
    const j = (await r.json().catch(() => ({}))) as any;
    return { ok: !!j.ok, error: j.error };
  }

  /** Register this agent as a listener. */
  async subscribe(callbackUrl?: string): Promise<boolean> {
    const r = await fetch(this.url('/api/telegram/subscribe'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ agent_id: this.opts.agentId, callback_url: callbackUrl }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean };
    return !!j.ok;
  }

  async unsubscribe(): Promise<boolean> {
    const r = await fetch(this.url('/api/telegram/unsubscribe'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ agent_id: this.opts.agentId }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean };
    return !!j.ok;
  }

  /** Make this agent the active listener. */
  async activate(): Promise<boolean> {
    const r = await fetch(this.url('/api/telegram/activate'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ agent_id: this.opts.agentId }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean };
    return !!j.ok;
  }

  /** Poll pending replies (drains the inbox). */
  async poll(): Promise<TelegramMessage[]> {
    const url = `${this.url('/api/telegram/inbox')}?agent=${encodeURIComponent(this.opts.agentId)}${this.opts.secret ? `&secret=${encodeURIComponent(this.opts.secret)}` : ''}`;
    const r = await fetch(url, { headers: this.headers() });
    const j = (await r.json().catch(() => ({}))) as { messages?: TelegramMessage[] };
    return j.messages ?? [];
  }

  /** Register the webhook URL with Telegram (owner-only, call once). */
  async setup(webhookUrl: string): Promise<{ ok: boolean; error?: string }> {
    const r = await fetch(this.url('/api/telegram/setup'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ url: webhookUrl }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return { ok: !!j.ok, error: j.error };
  }

  /** Gateway status. */
  async status(): Promise<{ configured: boolean; active: string | null; subscriptions: { agent_id: string; callback_url?: string }[] }> {
    const r = await fetch(this.url('/api/telegram/status'), { headers: this.headers() });
    return (await r.json().catch(() => ({}))) as any;
  }

  // --- 決策/核准 API ----------------------------------------------------------

  /** 建立「批准/駁回」請求，發送到 Telegram，結果回傳 callback_url 或可輪詢。 */
  async askApprove(opts: { text: string; description?: string; callback_url?: string; correlation_id?: string; metadata?: unknown; timeout_sec?: number; approve_label?: string; reject_label?: string }): Promise<any> {
    return this.decision({ type: 'approve', ...opts });
  }

  /** 建立單選請求。options: [{key,label}] */
  async askPick(opts: { text: string; options: { key: string; label: string }[]; description?: string; callback_url?: string; correlation_id?: string; metadata?: unknown; timeout_sec?: number }): Promise<any> {
    return this.decision({ type: 'pick', ...opts });
  }

  /** 建立多選請求（可勾選多項後送出）。options: [{key,label}] */
  async askMulti(opts: { text: string; options: { key: string; label: string }[]; description?: string; callback_url?: string; correlation_id?: string; metadata?: unknown; timeout_sec?: number; submit_label?: string; cancel_label?: string }): Promise<any> {
    return this.decision({ type: 'multi', ...opts });
  }

  /** 建立決策請求（通用）。 */
  async decision(body: Record<string, unknown>): Promise<any> {
    const r = await fetch(this.url('/api/telegram/decisions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ agent_id: this.opts.agentId, callback_url: (this.opts as any).callbackUrl, ...body }),
    });
    return (await r.json().catch(() => ({}))) as any;
  }

  /** 查詢決策結果。 */
  async getDecision(id: string): Promise<any> {
    const r = await fetch(this.url(`/api/telegram/decisions/${encodeURIComponent(id)}`), { headers: this.headers() });
    return (await r.json().catch(() => ({}))) as any;
  }

  /** 列出本 agent 的決策。 */
  async listDecisions(): Promise<any> {
    const r = await fetch(this.url(`/api/telegram/decisions?agent=${encodeURIComponent(this.opts.agentId)}`), { headers: this.headers() });
    return (await r.json().catch(() => ({}))) as any;
  }

  /** 取消決策。 */
  async cancelDecision(id: string): Promise<any> {
    const r = await fetch(this.url(`/api/telegram/decisions/${encodeURIComponent(id)}/cancel`), { method: 'POST', headers: this.headers() });
    return (await r.json().catch(() => ({}))) as any;
  }
}
