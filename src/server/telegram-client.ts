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
  async send(text: string, replyMarkup?: unknown): Promise<{ ok: boolean; error?: string }> {
    const r = await fetch(this.url('/api/telegram/send'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ text, reply_markup: replyMarkup }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
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
}
