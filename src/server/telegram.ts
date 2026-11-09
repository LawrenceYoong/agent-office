// Telegram gateway: one bot for every project, sending to the owner and routing their replies
// back to whichever agent is listening. Credentials come from the environment (never from git).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';

export interface TelegramConfig {
  botToken?: string;
  webhookSecret?: string;
  ownerChatId?: string;
  gatewaySecret?: string;
  dataDir: string;
  /** Public URL Telegram will POST updates to (set via /api/telegram/setup or env). */
  webhookUrl?: string;
}

export interface TelegramSubscription {
  agent_id: string;
  callback_url?: string;
}

export interface TelegramInboxMessage {
  id: number;
  from: string;
  text: string;
  at: number;
}

interface PersistedState {
  subscriptions: Record<string, TelegramSubscription>;
  active: string | null;
  inboxes: Record<string, TelegramInboxMessage[]>;
  processed: number[];
}

const TELEGRAM_API = 'https://api.telegram.org';

export class TelegramGateway {
  private state: PersistedState;
  private readonly statePath: string;
  private readonly replyHandlers: Array<(agentId: string, msg: TelegramInboxMessage) => void> = [];
  private callbackInterceptors: Array<(data: string, from: string, updateId: number) => boolean | Promise<boolean>> = [];

  constructor(private readonly cfg: TelegramConfig) {
    mkdirSync(cfg.dataDir, { recursive: true });
    this.statePath = path.join(cfg.dataDir, 'telegram.json');
    this.state = { subscriptions: {}, active: null, inboxes: {}, processed: [] };
    this.restore();
  }

  /** Register a handler that can claim callback_data (e.g. decision buttons). Return true if consumed. */
  onCallbackData(cb: (data: string, from: string, updateId: number) => boolean | Promise<boolean>): void {
    this.callbackInterceptors.push(cb);
  }

  /** Whether the bot is configured at all. */
  configured(): boolean {
    return !!this.cfg.botToken;
  }

  /** Send a message to the owner (or an explicit chat). */
  async send(text: string, chatId?: string, replyMarkup?: unknown): Promise<{ ok: boolean; error?: string; result?: any }> {
    if (!this.cfg.botToken) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
    const target = chatId ?? this.cfg.ownerChatId;
    if (!target) return { ok: false, error: 'no chat id' };
    try {
      const r = await fetch(`${TELEGRAM_API}/bot${this.cfg.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: target, text, parse_mode: 'Markdown', reply_markup: replyMarkup }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: any };
      if (!j.ok) return { ok: false, error: j.description ?? `HTTP ${r.status}` };
      return { ok: true, result: j.result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Edit a message's inline keyboard (for multi-select/toggle flows). */
  async editMessageReplyMarkup(chatId: string | number, messageId: number, replyMarkup: unknown): Promise<{ ok: boolean; error?: string; result?: any }> {
    if (!this.cfg.botToken) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
    try {
      const r = await fetch(`${TELEGRAM_API}/bot${this.cfg.botToken}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: any };
      if (!j.ok) return { ok: false, error: j.description ?? `HTTP ${r.status}` };
      return { ok: true, result: j.result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Edit a message's text and optionally its inline keyboard. */
  async editMessageText(chatId: string | number, messageId: number, text: string, replyMarkup?: unknown): Promise<{ ok: boolean; error?: string; result?: any }> {
    if (!this.cfg.botToken) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
    try {
      const r = await fetch(`${TELEGRAM_API}/bot${this.cfg.botToken}/editMessageText`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown', reply_markup: replyMarkup }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: any };
      if (!j.ok) return { ok: false, error: j.description ?? `HTTP ${r.status}` };
      return { ok: true, result: j.result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  ownerChatId(): string | undefined { return this.cfg.ownerChatId; }
  gatewaySecret(): string | undefined { return this.cfg.gatewaySecret; }

  /** Register the webhook URL with Telegram. */
  async setWebhook(url: string): Promise<{ ok: boolean; error?: string; result?: unknown }> {
    if (!this.cfg.botToken) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
    try {
      const r = await fetch(`${TELEGRAM_API}/bot${this.cfg.botToken}/setWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, secret_token: this.cfg.webhookSecret }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown };
      if (!j.ok) return { ok: false, error: j.description ?? `HTTP ${r.status}` };
      this.cfg.webhookUrl = url;
      return { ok: true, result: j.result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Remove the webhook (switch to polling-style, for local dev). */
  async deleteWebhook(): Promise<{ ok: boolean; error?: string }> {
    if (!this.cfg.botToken) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
    try {
      const r = await fetch(`${TELEGRAM_API}/bot${this.cfg.botToken}/deleteWebhook`, { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string };
      if (!j.ok) return { ok: false, error: j.description ?? `HTTP ${r.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.cfg.botToken) return;
    try {
      await fetch(`${TELEGRAM_API}/bot${this.cfg.botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      });
    } catch { /* best effort */ }
  }

  subscribe(agentId: string, callbackUrl?: string): void {
    this.state.subscriptions[agentId] = { agent_id: agentId, callback_url: callbackUrl };
    this.state.inboxes[agentId] ??= [];
    this.persist();
  }

  unsubscribe(agentId: string): void {
    delete this.state.subscriptions[agentId];
    delete this.state.inboxes[agentId];
    if (this.state.active === agentId) this.state.active = null;
    this.persist();
  }

  activate(agentId: string): boolean {
    if (!this.state.subscriptions[agentId]) return false;
    this.state.active = agentId;
    this.persist();
    return true;
  }

  inbox(agentId: string): TelegramInboxMessage[] {
    return this.state.inboxes[agentId] ?? [];
  }

  /** Drain an agent's inbox (returns and clears), dispatching each to registered handlers. */
  drain(agentId: string): TelegramInboxMessage[] {
    const msgs = this.state.inboxes[agentId] ?? [];
    this.state.inboxes[agentId] = [];
    for (const m of msgs) this.dispatchReply(agentId, m);
    this.persist();
    return msgs;
  }

  activeListener(): string | null {
    return this.state.active;
  }

  /** Verify Telegram Mini App initData. Returns the user id on success. */
  verifyInitData(initData: string): { ok: boolean; userId?: number; error?: string } {
    if (!this.cfg.botToken) return { ok: false, error: 'not configured' };
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { ok: false, error: 'no hash' };
    params.delete('hash');
    const keys = [...params.keys()].sort();
    const dataCheckString = keys.map((k) => `${k}=${params.get(k)}`).join('\n');
    const secretKey = createHmac('sha256', 'WebAppData').update(this.cfg.botToken).digest();
    const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computed !== hash) return { ok: false, error: 'bad hash' };
    const authDate = Number(params.get('auth_date'));
    if (!authDate || Date.now() / 1000 - authDate > 3600) return { ok: false, error: 'expired' };
    let user: any;
    try { user = JSON.parse(params.get('user') ?? ''); } catch { return { ok: false, error: 'bad user' }; }
    if (!user || String(user.id) !== String(this.cfg.ownerChatId)) return { ok: false, error: 'not owner' };
    return { ok: true, userId: user.id };
  }

  onReply(cb: (agentId: string, msg: TelegramInboxMessage) => void): void {
    this.replyHandlers.push(cb);
  }

  dispatchReply(agentId: string, msg: TelegramInboxMessage): void {
    for (const cb of this.replyHandlers) {
      try { cb(agentId, msg); } catch { /* handler errors must not break dispatch */ }
    }
  }


  subscriptions(): TelegramSubscription[] {
    return Object.values(this.state.subscriptions);
  }

  /** Process a Telegram update. Returns whether it was handled. */
  async handleUpdate(update: any): Promise<boolean> {
    if (!update || typeof update.update_id !== 'number') return false;
    if (this.state.processed.includes(update.update_id)) return false;
    this.state.processed.push(update.update_id);
    if (this.state.processed.length > 2000) this.state.processed = this.state.processed.slice(-2000);

    // Inline-button taps arrive as callback_query, not message.
    const cq = update.callback_query;
    if (cq) {
      if (this.cfg.ownerChatId && String(cq.from?.id) !== String(this.cfg.ownerChatId)) { this.persist(); return false; }
      await this.answerCallbackQuery(cq.id);
      const data: string = cq.data ?? '';
      const from = String(cq.from?.id ?? '');
      for (const cb of this.callbackInterceptors) {
        try { if (await cb(data, from, update.update_id)) { this.persist(); return true; } } catch { /* interceptor errors must not break routing */ }
      }
      const target = this.state.active;
      if (target && this.state.subscriptions[target]) {
        const inboxMsg: TelegramInboxMessage = { id: update.update_id, from, text: data, at: Date.now() };
        const sub = this.state.subscriptions[target];
        if (sub.callback_url) {
          void fetch(sub.callback_url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-gateway-secret': this.cfg.gatewaySecret ?? '' }, body: JSON.stringify({ agent_id: target, message: inboxMsg }) }).catch(() => { (this.state.inboxes[target] ??= []).push(inboxMsg); this.persist(); });
        } else {
          (this.state.inboxes[target] ??= []).push(inboxMsg);
        }
      }
      this.persist();
      return true;
    }

    const msg = update.message ?? update.edited_message;
    if (!msg) { this.persist(); return false; }

    // Only the owner may talk to the bot.
    const fromId = msg.from?.id;
    if (this.cfg.ownerChatId && String(fromId) !== String(this.cfg.ownerChatId)) {
      this.persist();
      return false;
    }

    const text: string = (msg.text ?? '').trim();
    if (!text) { this.persist(); return false; }

    // Built-in commands.
    if (text === '/start') { await this.send('Telegram gateway ready. Active listener: ' + (this.state.active ?? 'none') + '. Use /agents, /activate <agent>, /agent <name> <text>.'); this.persist(); return true; }
    if (text === '/status') { await this.send('Active: ' + (this.state.active ?? 'none') + '\nSubscriptions: ' + Object.keys(this.state.subscriptions).join(', ')); this.persist(); return true; }
    if (text === '/agents' || text === '/list') { await this.send('Subscribed agents: ' + Object.keys(this.state.subscriptions).join(', ') || '(none)'); this.persist(); return true; }
    const actM = text.match(/^\/activate\s+(\S+)\s*$/i);
    if (actM) { const ok = this.activate(actM[1]); await this.send(ok ? 'Activated ' + actM[1] : 'Unknown agent ' + actM[1]); this.persist(); return true; }

    // Addressed routing: "/agent <name> <text>"
    let target = this.state.active;
    let body = text;
    const m = text.match(/^\/agent\s+(\S+)\s*([\s\S]*)$/i);
    if (m) { target = m[1]; body = (m[2] ?? '').trim(); }

    if (!target || !this.state.subscriptions[target]) {
      // No listener: acknowledge so the owner isn't left hanging.
      await this.send(`No listening agent (${target ?? 'none'}). Use /activate <agent> first.`, String(fromId));
      this.persist();
      return true;
    }

    const sub = this.state.subscriptions[target];
    const inboxMsg: TelegramInboxMessage = { id: update.update_id, from: String(fromId), text: body, at: Date.now() };

    if (sub.callback_url) {
      // Push to the agent; do not block on its response.
      void fetch(sub.callback_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-gateway-secret': this.cfg.gatewaySecret ?? '' },
        body: JSON.stringify({ agent_id: target, message: inboxMsg }),
      }).catch(() => { /* agent offline: fall back to inbox */ (this.state.inboxes[target] ??= []).push(inboxMsg); this.persist(); });
    } else {
      (this.state.inboxes[target] ??= []).push(inboxMsg);
    }
    this.persist();
    return true;
  }

  /** Verify the webhook secret token Telegram sends. */
  verifyWebhookSecret(headerValue: string | undefined): boolean {
    if (!this.cfg.webhookSecret) return true; // not configured → allow (dev)
    return headerValue === this.cfg.webhookSecret;
  }

  private restore() {
    if (!existsSync(this.statePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<PersistedState>;
      this.state = {
        subscriptions: saved.subscriptions ?? {},
        active: saved.active ?? null,
        inboxes: saved.inboxes ?? {},
        processed: saved.processed ?? [],
      };
    } catch {
      // corrupt state: start fresh
    }
  }

  private persist() {
    try {
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch {
      // disk issues must not take the office down
    }
  }
}
