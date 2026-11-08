// Telegram gateway routes: a public webhook Telegram calls, plus agent/owner endpoints.
import type { Ctx } from '../../office/context.js';
import { send } from '../util.js';
import type { Route } from '../router.js';

function authorized(ctx: Ctx, req: import('node:http').IncomingMessage): boolean {
  const secret = (req.headers['x-telegram-gateway-secret'] as string | undefined) ?? '';
  if (ctx.cfg.telegramGatewaySecret && secret === ctx.cfg.telegramGatewaySecret) return true;
  // Fall back to a signed-in browser (the owner using the office UI).
  return !!ctx.auth.fromRequest(req);
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
} satisfies Record<string, Route>;
