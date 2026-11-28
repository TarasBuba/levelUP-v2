import {
  constantTimeEqual,
  verifySignedAdminToken,
} from '../../src/lib/admin-signing';
import {
  AFTERNOON_TIME_RANGE,
  type CalendarStoreEnv,
  getCalendarSchedule,
  MORNING_TIME_RANGE,
  setSlotStateAdmin,
} from '../../src/lib/calendar-store';
import {
  buildCapiEventPayload,
  type CapiEnv,
  dispatchMetaCapiEvent,
} from '../../src/lib/capi';
import {
  AUTHORIZED_TELEGRAM_ADMIN_IDS,
  escapeTelegramHtml,
} from '../../src/lib/lead-pipeline';
import type { SlotState, SlotWindow } from '../../src/types/contracts';

export interface AdminActionEnv extends CapiEnv, CalendarStoreEnv {
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_ACTION_SECRET?: string;
  ADMIN_DASHBOARD_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
}

export interface AdminActionContext {
  request: Request;
  env?: AdminActionEnv;
  params?: Record<string, string | string[]>;
  waitUntil?: (promise: Promise<unknown>) => void;
  fetchImpl?: typeof fetch;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': 'https://levelupcleaning.ca',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
};

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function jsonResponse(payload: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      ...CORS_HEADERS,
    },
  });
}

function htmlStatusPage(
  status: number,
  badge: string,
  title: string,
  summary: string,
  details: Array<{ label: string; value: string }>,
  primaryAction?: { label: string; href: string },
): Response {
  const accentColor = status >= 400 ? '#9B2C2C' : '#2E6B57';
  const badgeBg = status >= 400 ? '#FDE8E8' : '#E7F3EE';
  const rowsHtml = details
    .map(
      (item) =>
        `<tr><td style="padding:8px 0;color:#52615A;font-size:14px;">${escapeTelegramHtml(item.label)}</td><td style="padding:8px 0;text-align:right;font-weight:600;font-size:14px;color:#172A22;">${escapeTelegramHtml(item.value)}</td></tr>`,
    )
    .join('');

  const primaryButtonHtml = primaryAction
    ? `<a href="${escapeTelegramHtml(primaryAction.href)}" style="display:inline-block;margin-top:18px;padding:12px 20px;border-radius:999px;background:#2E6B57;color:#FAF8F4;text-decoration:none;font-weight:600;font-size:14px;">${escapeTelegramHtml(primaryAction.label)}</a>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escapeTelegramHtml(title)} — LevelUp Cleaning Admin</title>
</head>
<body style="margin:0;padding:24px;background:#FAF8F4;color:#172A22;font-family:Inter,system-ui,-apple-system,sans-serif;">
  <main style="max-width:520px;margin:28px auto;background:#FFFFFF;border:1px solid #E2DDD5;border-radius:20px;padding:28px;box-shadow:0 12px 30px rgba(23,42,34,0.06);">
    <span style="display:inline-block;padding:6px 12px;border-radius:999px;background:${badgeBg};color:${accentColor};font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;">${escapeTelegramHtml(badge)}</span>
    <h1 style="margin:14px 0 8px;font-size:24px;line-height:1.2;color:#172A22;">${escapeTelegramHtml(title)}</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#46544E;">${escapeTelegramHtml(summary)}</p>
    ${rowsHtml ? `<table style="width:100%;border-collapse:collapse;border-top:1px solid #ECE7DF;border-bottom:1px solid #ECE7DF;">${rowsHtml}</table>` : ''}
    <div>
      ${primaryButtonHtml}
      <a href="/admin/calendar" style="display:inline-block;margin-top:18px;margin-left:${primaryAction ? '10px' : '0'};padding:12px 18px;border-radius:999px;border:1px solid #D1CBC0;color:#172A22;text-decoration:none;font-weight:600;font-size:14px;">Open Admin Calendar</a>
    </div>
  </main>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

function formatWindowText(windowChoice: SlotWindow): string {
  if (windowChoice === 'morning') {
    return `Morning (${MORNING_TIME_RANGE})`;
  }
  if (windowChoice === 'afternoon') {
    return `Afternoon (${AFTERNOON_TIME_RANGE})`;
  }
  return 'Full Day (8:30 AM – 4:30 PM)';
}

async function notifyTelegramAdmins(
  botToken: string,
  text: string,
  fetcher: typeof fetch,
): Promise<void> {
  if (!botToken) {
    return;
  }
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  for (const chatId of AUTHORIZED_TELEGRAM_ADMIN_IDS) {
    try {
      await fetcher(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
    } catch {
      continue;
    }
  }
}

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export async function onRequestGet(context: AdminActionContext): Promise<Response> {
  const signingSecret =
    context.env?.TELEGRAM_WEBHOOK_SECRET?.trim() ||
    context.env?.ADMIN_ACTION_SECRET?.trim() ||
    context.env?.ADMIN_DASHBOARD_SECRET?.trim() ||
    '';

  if (!signingSecret) {
    return htmlStatusPage(
      503,
      'Configuration Needed',
      'Admin Action Secret Missing',
      'Configure TELEGRAM_WEBHOOK_SECRET or ADMIN_DASHBOARD_SECRET in your deployment environment.',
      [],
    );
  }

  const url = new URL(context.request.url);
  const token = url.searchParams.get('token') ?? '';
  if (!token) {
    return htmlStatusPage(
      400,
      'Invalid Request',
      'Missing Admin Action Token',
      'Open this link directly from a LevelUp Cleaning Telegram dispatch message.',
      [],
    );
  }

  const verified = await verifySignedAdminToken(token, signingSecret);
  if (!verified.valid) {
    return htmlStatusPage(
      403,
      'Access Denied',
      'Invalid or Expired Action Link',
      verified.error,
      [],
    );
  }

  const payload = verified.payload;
  const fetcher = context.fetchImpl ?? globalThis.fetch;
  const botToken = context.env?.TELEGRAM_BOT_TOKEN?.trim() ?? '';

  if (payload.action === 'confirm_slot') {
    if (!payload.date || !payload.window) {
      return htmlStatusPage(
        400,
        'Invalid Slot',
        'Missing Slot Date or Window',
        'This action token does not specify a calendar date and window.',
        [{ label: 'Lead ID', value: `#${payload.leadId}` }],
      );
    }

    const updated = await setSlotStateAdmin(
      payload.date,
      payload.window,
      'booked',
      payload.leadId,
      context.env,
      { fetchImpl: fetcher },
    );

    if (!updated.ok) {
      return htmlStatusPage(
        400,
        'Update Failed',
        'Could Not Lock Requested Slot',
        'Check the date format or update manually from the Admin Calendar.',
        [{ label: 'Lead ID', value: `#${payload.leadId}` }],
      );
    }

    await notifyTelegramAdmins(
      botToken,
      `✅ <b>Slot Confirmed &amp; Locked</b> — <code>#${escapeTelegramHtml(payload.leadId)}</code>\n🗓 ${escapeTelegramHtml(payload.date)} • ${escapeTelegramHtml(formatWindowText(payload.window))}\n📊 Open slots next 7 days: <b>${updated.schedule.weeklyOpenSlots}</b>`,
      fetcher,
    );

    const smsDigits = payload.phone ? payload.phone.replace(/[^\d+]/g, '') : '';
    const smsHref = smsDigits
      ? `sms:${smsDigits}?&body=${encodeURIComponent(`Hi ${payload.name || 'there'}! Your LevelUp Cleaning Edmonton appointment on ${payload.date} (${formatWindowText(payload.window)}) is officially confirmed. Reference #${payload.leadId}.`)}`
      : undefined;

    return htmlStatusPage(
      200,
      'Slot Confirmed',
      'Appointment Window Locked',
      'The live Edmonton booking calendar has been updated to Booked.',
      [
        { label: 'Lead Reference', value: `#${payload.leadId}` },
        { label: 'Date', value: payload.date },
        { label: 'Window', value: formatWindowText(payload.window) },
        { label: 'Open Slots (Next 7 Days)', value: String(updated.schedule.weeklyOpenSlots) },
      ],
      smsHref ? { label: 'Send Client Confirmation SMS', href: smsHref } : undefined,
    );
  }

  if (payload.action === 'release_slot') {
    if (!payload.date || !payload.window) {
      return htmlStatusPage(
        400,
        'Invalid Slot',
        'Missing Slot Date or Window',
        'This release link does not include a calendar slot.',
        [{ label: 'Lead ID', value: `#${payload.leadId}` }],
      );
    }

    const updated = await setSlotStateAdmin(
      payload.date,
      payload.window,
      'available',
      undefined,
      context.env,
      { fetchImpl: fetcher },
    );

    await notifyTelegramAdmins(
      botToken,
      `🔓 <b>Slot Released to Available</b> — <code>#${escapeTelegramHtml(payload.leadId)}</code>\n🗓 ${escapeTelegramHtml(payload.date)} • ${escapeTelegramHtml(formatWindowText(payload.window))}\n📊 Open slots next 7 days: <b>${updated.schedule.weeklyOpenSlots}</b>`,
      fetcher,
    );

    return htmlStatusPage(
      200,
      'Slot Released',
      'Appointment Window Re-Opened',
      'The live Edmonton calendar window is available again for new bookings.',
      [
        { label: 'Lead Reference', value: `#${payload.leadId}` },
        { label: 'Date', value: payload.date },
        { label: 'Window', value: formatWindowText(payload.window) },
        { label: 'Open Slots (Next 7 Days)', value: String(updated.schedule.weeklyOpenSlots) },
      ],
    );
  }

  if (payload.action === 'confirm_price') {
    const amount = typeof payload.amountCad === 'number' && Number.isFinite(payload.amountCad)
      ? Math.round(payload.amountCad)
      : 0;
    const smsDigits = payload.phone ? payload.phone.replace(/[^\d+]/g, '') : '+17807101503';
    const smsBody = `Hi ${payload.name || 'there'}! Thanks for sending your details to LevelUp Cleaning Edmonton. Your locked pre-tax price is $${amount} CAD (+ 5% AB GST where applicable) for reference #${payload.leadId}. Reply YES to finalize.`;
    const smsHref = `sms:${smsDigits}?&body=${encodeURIComponent(smsBody)}`;

    await notifyTelegramAdmins(
      botToken,
      `📸 <b>Price Confirmation Opened</b> — <code>#${escapeTelegramHtml(payload.leadId)}</code> ($${amount} CAD)`,
      fetcher,
    );

    return htmlStatusPage(
      200,
      'Price Ready',
      'Send Client Price Confirmation SMS',
      'Tap below to open your pre-filled SMS message with the confirmed pre-tax CAD total.',
      [
        { label: 'Lead Reference', value: `#${payload.leadId}` },
        { label: 'Client', value: payload.name || 'Customer' },
        { label: 'Confirmed Pre-Tax Price', value: `$${amount} CAD (+ 5% AB GST)` },
      ],
      { label: 'Open Pre-Filled SMS', href: smsHref },
    );
  }

  const amount =
    typeof payload.amountCad === 'number' && Number.isFinite(payload.amountCad)
      ? Math.max(0, Math.round(payload.amountCad * 100) / 100)
      : 0;
  const service = payload.service ?? 'regular';

  const capiPayload = await buildCapiEventPayload({
    eventName: 'Purchase',
    eventId: payload.leadId,
    actionSource: 'system_generated',
    value: amount,
    currency: 'CAD',
    contentName: `Completed ${service} Clean`,
    contentCategory: service,
    externalId: payload.leadId,
  });

  const capiResult = await dispatchMetaCapiEvent(capiPayload, context.env, fetcher);

  await notifyTelegramAdmins(
    botToken,
    `💰 <b>Payment Recorded</b> — <code>#${escapeTelegramHtml(payload.leadId)}</code>\n💵 Amount: <b>$${amount} CAD</b> (${escapeTelegramHtml(service)})\n📡 Meta CAPI Purchase: <b>${capiResult.dispatched ? 'Dispatched' : 'Demo / Unconfigured'}</b>`,
    fetcher,
  );

  return htmlStatusPage(
    200,
    'Payment Logged',
    'Completed Clean Recorded',
    capiResult.dispatched
      ? 'Payment has been logged and synced as a Purchase conversion to Meta CAPI.'
      : 'Payment receipt logged in Telegram (Meta CAPI credentials not configured in this environment).',
    [
      { label: 'Lead Reference', value: `#${payload.leadId}` },
      { label: 'Amount Recorded', value: `$${amount} CAD` },
      { label: 'Service', value: service },
      { label: 'Meta CAPI Sync', value: capiResult.dispatched ? 'Sent' : 'Skipped' },
    ],
  );
}

export async function onRequestPost(context: AdminActionContext): Promise<Response> {
  const configuredSecret =
    context.env?.ADMIN_DASHBOARD_SECRET?.trim() ||
    context.env?.TELEGRAM_WEBHOOK_SECRET?.trim() ||
    '';

  if (!configuredSecret) {
    return jsonResponse(
      { ok: false, error: 'Unauthorized: admin dashboard secret is not configured.' },
      401,
    );
  }

  const providedSecret = context.request.headers.get('X-Admin-Secret') ?? '';
  if (!providedSecret) {
    return jsonResponse(
      { ok: false, error: 'Unauthorized: missing X-Admin-Secret header.' },
      401,
    );
  }

  const secretMatches = await constantTimeEqual(providedSecret, configuredSecret);
  if (!secretMatches) {
    return jsonResponse({ ok: false, error: 'Forbidden: invalid admin secret.' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    const raw = await context.request.json();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return jsonResponse({ ok: false, error: 'Request body must be a JSON object.' }, 400);
    }
    body = raw as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, error: 'Malformed JSON body.' }, 400);
  }

  const action = body.action;
  if (action === 'list') {
    const schedule = await getCalendarSchedule(context.env, {
      fetchImpl: context.fetchImpl,
    });
    return jsonResponse({ ok: true, schedule }, 200);
  }

  if (action === 'set_slot') {
    const date = typeof body.date === 'string' ? body.date.trim() : '';
    const windowChoice = body.window;
    const state = body.state;
    const leadId =
      typeof body.leadId === 'string' && body.leadId.trim().length > 0
        ? body.leadId.trim().slice(0, 64)
        : undefined;

    if (
      !DATE_KEY_PATTERN.test(date) ||
      (windowChoice !== 'morning' && windowChoice !== 'afternoon' && windowChoice !== 'full_day') ||
      (state !== 'available' && state !== 'pending' && state !== 'booked')
    ) {
      return jsonResponse(
        { ok: false, error: 'Invalid slot parameters. Provide date, window, and state.' },
        400,
      );
    }

    const updated = await setSlotStateAdmin(
      date,
      windowChoice as SlotWindow,
      state as SlotState,
      leadId,
      context.env,
      { fetchImpl: context.fetchImpl },
    );

    if (!updated.ok) {
      return jsonResponse({ ok: false, error: 'Failed to update slot state.' }, 400);
    }

    return jsonResponse({ ok: true, schedule: updated.schedule }, 200);
  }

  return jsonResponse({ ok: false, error: 'Unsupported admin action.' }, 400);
}
