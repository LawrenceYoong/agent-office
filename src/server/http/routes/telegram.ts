// Telegram gateway routes: a public webhook Telegram calls, plus agent/owner endpoints.
import type { Ctx } from '../../office/context.js';
import { isSecure, send } from '../util.js';
import type { Route } from '../router.js';

function authorized(ctx: Ctx, req: import('node:http').IncomingMessage): boolean {
  const secret = (req.headers['x-telegram-gateway-secret'] as string | undefined) ?? '';
  if (ctx.cfg.telegramGatewaySecret && secret === ctx.cfg.telegramGatewaySecret) return true;
  // Fall back to a signed-in browser (the owner using the office UI).
  return !!ctx.auth.fromRequest(req);
}

async function readJson(req: import('node:http').IncomingMessage): Promise<any | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return null; }
}

export const telegramRoutes = {
  // Telegram calls this (public). Verified by the secret token header.
  webhook: {
    method: 'POST',
    path: '/api/telegram/webhook',
    auth: 'public',
    handle: async (ctx, { req, res }) => {
      const token = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;
      if (!ctx.telegram.verifyWebhookSecret(token)) return send(res, 401, { error: 'bad secret' });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let update: any;
      try { update = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
      const handled = await ctx.telegram.handleUpdate(update);
      return send(res, 200, { ok: true, handled });
    },
  },
  // Owner/agent: send a message to the owner.
  send: {
    method: 'POST',
    path: '/api/telegram/send',
    auth: 'public',
    handle: async (ctx, { req, res }) => {
      if (!authorized(ctx, req)) return send(res, 401, { error: 'not authorized' });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
      const r = await ctx.telegram.send(String(body?.text ?? ''), body?.chat_id, body?.reply_markup);
      return send(res, r.ok ? 200 : 502, r);
    },
  },
  // Agent registers itself.
  subscribe: {
    method: 'POST',
    path: '/api/telegram/subscribe',
    auth: 'public',
    handle: async (ctx, { req, res }) => {
      if (!authorized(ctx, req)) return send(res, 401, { error: 'not authorized' });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
      if (!body?.agent_id) return send(res, 400, { error: 'agent_id required' });
      ctx.telegram.subscribe(String(body.agent_id), body.callback_url ? String(body.callback_url) : undefined);
      return send(res, 200, { ok: true });
    },
  },
  // Agent unregisters.
  unsubscribe: {
    method: 'POST',
    path: '/api/telegram/unsubscribe',
    auth: 'public',
    handle: async (ctx, { req, res }) => {
      if (!authorized(ctx, req)) return send(res, 401, { error: 'not authorized' });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
      if (!body?.agent_id) return send(res, 400, { error: 'agent_id required' });
      ctx.telegram.unsubscribe(String(body.agent_id));
      return send(res, 200, { ok: true });
    },
  },
  // Make an agent the active listener.
  activate: {
    method: 'POST',
    path: '/api/telegram/activate',
    auth: 'public',
    handle: async (ctx, { req, res }) => {
      if (!authorized(ctx, req)) return send(res, 401, { error: 'not authorized' });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
      if (!body?.agent_id) return send(res, 400, { error: 'agent_id required' });
      const ok = ctx.telegram.activate(String(body.agent_id));
      return send(res, ok ? 200 : 404, { ok });
    },
  },
  // Poll pending replies (for agents without a callback URL).
  inbox: {
    method: 'GET',
    path: '/api/telegram/inbox',
    auth: 'public',
    handle: (ctx, { req, url, res }) => {
      const agentId = url.searchParams.get('agent');
      if (!agentId) return send(res, 400, { error: 'agent query param required' });
      const headerSecret = (req.headers['x-telegram-gateway-secret'] as string | undefined) ?? '';
      const qSecret = url.searchParams.get('secret') ?? '';
      const authed = (ctx.cfg.telegramGatewaySecret && (headerSecret === ctx.cfg.telegramGatewaySecret || qSecret === ctx.cfg.telegramGatewaySecret)) || !!ctx.auth.fromRequest(req);
      if (!authed) return send(res, 401, { error: 'not authorized' });
      const msgs = ctx.telegram.drain(agentId);
      return send(res, 200, { messages: msgs });
    },
  },
  // Register the webhook URL with Telegram.
  setup: {
    method: 'POST',
    path: '/api/telegram/setup',
    auth: 'public',
    handle: async (ctx, { req, res }) => {
      if (!authorized(ctx, req)) return send(res, 401, { error: 'not authorized' });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
      if (!body?.url) return send(res, 400, { error: 'url required' });
      const r = await ctx.telegram.setWebhook(String(body.url));
      return send(res, r.ok ? 200 : 502, r);
    },
  },
  // Telegram dispatches a reply here (agent-office is the listening agent).
  reply: {
    method: 'POST',
    path: '/api/telegram/reply',
    auth: 'public',
    handle: async (ctx, { req, res }) => {
      const secret = (req.headers['x-telegram-gateway-secret'] as string | undefined) ?? '';
      if (ctx.cfg.telegramGatewaySecret && secret !== ctx.cfg.telegramGatewaySecret) return send(res, 401, { error: 'not authorized' });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
      const agentId = String(body?.agent_id ?? 'agent-office');
      const msg = body?.message;
      if (!msg) return send(res, 400, { error: 'message required' });
      ctx.telegram.dispatchReply(agentId, msg);
      // Surface the reply to everyone in the office.
      try { ctx.toastAll(`Telegram reply (${agentId}): ${msg.text ?? ''}`, 'info'); } catch { /* no clients */ }
      return send(res, 200, { ok: true });
    },
  },
  // Telegram Mini App auto-login: verifies initData, issues a session cookie.
  miniappAuth: {
    method: 'POST',
    path: '/api/telegram/miniapp-auth',
    auth: 'public',
    handle: async (ctx, { req, res }) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
      const r = ctx.telegram.verifyInitData(String(body?.initData ?? ''));
      if (!r.ok) return send(res, 401, { error: r.error ?? 'invalid' });
      const token = ctx.auth.issue();
      return send(res, 200, { ok: true, userId: r.userId }, { 'set-cookie': ctx.auth.cookie(req, token, isSecure(req, ctx.cfg)) });
    },
  },
  status: {
    method: 'GET',
    path: '/api/telegram/status',
    auth: 'public',
    handle: (ctx, { res }) => {
      return send(res, 200, {
        configured: ctx.telegram.configured(),
        active: ctx.telegram.activeListener(),
        subscriptions: ctx.telegram.subscriptions(),
      });
    },
  },
  // Gateway 原語：編輯訊息按鈕/文字（多選切換等）
  edit: {
    method: 'POST',
    path: '/api/telegram/edit',
    auth: 'public',
    handle: async (ctx, { req, res }) => {
      if (!authorized(ctx, req)) return send(res, 401, { error: 'not authorized' });
      const body = await readJson(req);
      if (!body) return send(res, 400, { error: 'bad json' });
      const chatId = body.chat_id ?? ctx.telegram.ownerChatId();
      const messageId = Number(body.message_id);
      if (!chatId || !Number.isFinite(messageId)) return send(res, 400, { error: 'chat_id (或預設 owner) 與 message_id 必填' });
      if (typeof body.text === 'string') {
        const r = await ctx.telegram.editMessageText(chatId, messageId, body.text, body.reply_markup);
        return send(res, r.ok ? 200 : 502, r);
      }
      const r = await ctx.telegram.editMessageReplyMarkup(chatId, messageId, body.reply_markup ?? { inline_keyboard: [] });
      return send(res, r.ok ? 200 : 502, r);
    },
  },
  // 決策/核准 API（中文為主）：其他專案送請求 → agent-office 發 Telegram 給 owner → 結果回傳 callback_url 或可輪詢
  decisions: {
    prefix: '/api/telegram/decisions',
    auth: 'public',
    handle: async (ctx, { req, res, url, path }) => {
      if (!authorized(ctx, req)) return send(res, 401, { error: 'not authorized' });
      const sub = path.slice('/api/telegram/decisions'.length).replace(/^\/+/, '');
      const method = req.method || 'GET';

      if (method === 'POST' && !sub) {
        const body = await readJson(req);
        if (!body) return send(res, 400, { error: 'bad json' });
        const r = await ctx.telegramDecisions.request(body);
        return send(res, r.ok ? 200 : 400, r);
      }
      if (method === 'GET' && !sub) {
        const id = url.searchParams.get('id');
        if (id) return send(res, 200, ctx.telegramDecisions.get(id));
        const agent = url.searchParams.get('agent') || undefined;
        return send(res, 200, { decisions: ctx.telegramDecisions.list(agent) });
      }
      if (sub) {
        const parts = sub.split('/').filter(Boolean);
        const id = parts[0];
        if (method === 'POST' && parts[1] === 'cancel') return send(res, 200, ctx.telegramDecisions.cancel(id));
        if (method === 'POST' && (parts[1] === 'resolve' || parts[1] === 'submit')) {
          const body = await readJson(req);
          if (!body) return send(res, 400, { error: 'bad json' });
          return send(res, 200, ctx.telegramDecisions.resolveAction(id, body, 'office-ui'));
        }
        if (method === 'GET') return send(res, 200, ctx.telegramDecisions.get(id));
      }
      return send(res, 405, { error: '用法: POST /api/telegram/decisions | GET /api/telegram/decisions?id=<id> | GET /api/telegram/decisions?agent=<agent_id> | POST /api/telegram/decisions/<id>/resolve | POST /api/telegram/decisions/<id>/cancel' });
    },
  },
} satisfies Record<string, Route>;
