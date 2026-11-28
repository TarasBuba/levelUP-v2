import { constantTimeEqual } from '../../src/lib/admin-signing';
import {
  buildCapiEventPayload,
  type CapiEnv,
  dispatchMetaCapiEvent,
} from '../../src/lib/capi';
import { AUTHORIZED_TELEGRAM_ADMIN_IDS } from '../../src/lib/lead-pipeline';
import { type KvNamespaceLike, parseSlotsValue } from '../../src/lib/slots';

export interface TelegramCallbackEnv extends CapiEnv {
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  LEVELUP_KV?: KvNamespaceLike;
}

export interface TelegramFunctionContext {
  request: Request;
  env: TelegramCallbackEnv;
  params?: Record<string, string | string[]>;
  waitUntil?: (promise: Promise<unknown>) => void;
  fetchImpl?: typeof fetch;
}

interface TelegramUser {
  id?: number | string;
}

interface TelegramChat {
  id?: number | string;
}

interface TelegramCallbackQuery {
  id?: string;
  from?: TelegramUser;
  data?: string;
}

interface TelegramMessage {
  from?: TelegramUser;
  chat?: TelegramChat;
  text?: string;
}

interface TelegramUpdate {
  callback_query?: TelegramCallbackQuery;
  message?: TelegramMessage;
}

const PAID_CALLBACK_REGEX =
  /^paid:([A-Za-z0-9_-]{1,48}):(\d+(?:\.\d{1,2})?):(move_out|deep_clean|regular|airbnb|hourly)$/;

const SLOTS_COMMAND_REGEX = /^\/slots(?:@[A-Za-z0-9_]+)?\s+([0-9])\s*$/i;

function jsonResponse(payload: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function isAuthorizedAdmin(senderId: string): boolean {
  return (AUTHORIZED_TELEGRAM_ADMIN_IDS as readonly string[]).includes(senderId);
}

export async function onRequestPost(context: TelegramFunctionContext): Promise<Response> {
  const configuredSecret = context.env?.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
  if (!configuredSecret) {
    return jsonResponse(
      { ok: false, error: 'Unauthorized: webhook secret is not configured.' },
      401,
    );
  }

  const providedSecret =
    context.request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (!providedSecret) {
    return jsonResponse(
      { ok: false, error: 'Unauthorized: missing secret token header.' },
      401,
    );
  }

  const secretMatches = await constantTimeEqual(providedSecret, configuredSecret);
  if (!secretMatches) {
    return jsonResponse(
      { ok: false, error: 'Forbidden: invalid webhook secret token.' },
      403,
    );
  }

  let update: TelegramUpdate;
  try {
    update = (await context.request.json()) as TelegramUpdate;
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid Telegram update JSON.' }, 400);
  }

  const fetcher = context.fetchImpl ?? globalThis.fetch;
  const botToken = context.env?.TELEGRAM_BOT_TOKEN?.trim() ?? '';

  if (update.callback_query) {
    const senderId =
      update.callback_query.from?.id !== undefined
        ? String(update.callback_query.from.id)
        : '';

    if (!isAuthorizedAdmin(senderId)) {
      return jsonResponse({ ok: false, error: 'Forbidden: unauthorized sender.' }, 403);
    }

    const rawData = String(update.callback_query.data ?? '').trim();
    const match = PAID_CALLBACK_REGEX.exec(rawData);
    if (!match) {
      return jsonResponse({ ok: false, error: 'Invalid callback_data payload.' }, 400);
    }

    const [, leadId, amountStr, service] = match;
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 20_000) {
      return jsonResponse({ ok: false, error: 'Invalid payment amount.' }, 400);
    }

    const capiPayload = await buildCapiEventPayload({
      eventName: 'Purchase',
      eventId: leadId,
      actionSource: 'system_generated',
      value: amount,
      currency: 'CAD',
      contentName: `Completed ${service} Clean`,
      contentCategory: service,
      externalId: leadId,
    });

    const capiResult = await dispatchMetaCapiEvent(capiPayload, context.env, fetcher);

    if (botToken && update.callback_query.id) {
      try {
        await fetcher(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: update.callback_query.id,
            text: `Recorded $${amount} CAD Purchase (#${leadId})`,
            show_alert: false,
          }),
        });
      } catch {
        void 0;
      }
    }

    return jsonResponse(
      {
        ok: true,
        action: 'purchase_recorded',
        leadId,
        amount,
        service,
        capiDispatched: capiResult.dispatched,
      },
      200,
    );
  }

  if (update.message) {
    const senderId =
      update.message.from?.id !== undefined ? String(update.message.from.id) : '';

    if (!isAuthorizedAdmin(senderId)) {
      return jsonResponse({ ok: false, error: 'Forbidden: unauthorized sender.' }, 403);
    }

    const text = String(update.message.text ?? '').trim();
    if (!text.toLowerCase().startsWith('/slots')) {
      return jsonResponse({ ok: true, action: 'ignored' }, 200);
    }

    const match = SLOTS_COMMAND_REGEX.exec(text);
    if (!match) {
      return jsonResponse({ ok: false, error: 'Usage: /slots <0-9>' }, 400);
    }

    const slots = parseSlotsValue(match[1]);
    let kvUpdated = false;

    if (context.env?.LEVELUP_KV) {
      await context.env.LEVELUP_KV.put('weekly_open_slots', String(slots));
      kvUpdated = true;
    }

    if (botToken && update.message.chat?.id !== undefined) {
      try {
        await fetcher(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: String(update.message.chat.id),
            text: `Weekly open slots in Edmonton updated to ${slots}.`,
          }),
        });
      } catch {
        void 0;
      }
    }

    return jsonResponse(
      {
        ok: true,
        action: 'slots_updated',
        slots,
        kvUpdated,
      },
      200,
    );
  }

  return jsonResponse({ ok: true, action: 'ignored' }, 200);
}
