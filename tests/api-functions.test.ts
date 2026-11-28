import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  onRequestGet as adminActionGet,
  onRequestOptions as adminActionOptions,
  onRequestPost as adminActionPost,
} from '../functions/api/admin-action';
import {
  onRequestGet as calendarGet,
  onRequestOptions as calendarOptions,
} from '../functions/api/calendar';
import {
  onRequestOptions as leadOptions,
  onRequestPost as leadPost,
} from '../functions/api/lead';
import { onRequestGet as slotsGet } from '../functions/api/slots';
import { onRequestPost as telegramPost } from '../functions/api/telegram-callback';
import { createSignedAdminToken } from '../src/lib/admin-signing';
import {
  getCalendarSchedule,
  resetMemoryCalendarStore,
  setSlotStateAdmin,
} from '../src/lib/calendar-store';

describe('functions/api/calendar.ts — Live 45-day Edmonton calendar endpoint', () => {
  beforeEach(() => {
    resetMemoryCalendarStore();
  });

  it('handles OPTIONS preflight and GET schedule payload with no-store headers', async () => {
    const optRes = await calendarOptions();
    expect(optRes.status).toBe(204);
    expect(optRes.headers.get('Access-Control-Allow-Methods')).toContain('GET');

    const getRes = await calendarGet({
      request: new Request('https://levelupcleaning.ca/api/calendar'),
    });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Cache-Control')).toBe('no-store');
    const json = await getRes.json();
    expect(json.timezone).toBe('America/Edmonton');
    expect(json.days).toHaveLength(45);
  });
});

describe('functions/api/admin-action.ts — Signed Telegram GET links and Admin Dashboard POST API', () => {
  const SECRET = 'whsec_admin_action_test_secret_2026';

  beforeEach(() => {
    resetMemoryCalendarStore();
  });

  it('handles OPTIONS CORS preflight with 204', async () => {
    const res = await adminActionOptions();
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Admin-Secret');
  });

  it('enforces signing secret configuration, missing token (400), and invalid/expired token (403) on GET', async () => {
    const noSecret = await adminActionGet({
      request: new Request('https://levelupcleaning.ca/api/admin-action?token=abc'),
      env: {},
    });
    expect(noSecret.status).toBe(503);
    expect(await noSecret.text()).toContain('Admin Action Secret Missing');

    const noToken = await adminActionGet({
      request: new Request('https://levelupcleaning.ca/api/admin-action'),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(noToken.status).toBe(400);
    expect(await noToken.text()).toContain('Missing Admin Action Token');

    const expiredToken = await createSignedAdminToken(
      { action: 'mark_paid', leadId: 'LU-EXP', exp: 100 },
      SECRET,
    );
    const expiredRes = await adminActionGet({
      request: new Request(
        `https://levelupcleaning.ca/api/admin-action?token=${encodeURIComponent(expiredToken)}`,
      ),
      env: { ADMIN_ACTION_SECRET: SECRET },
    });
    expect(expiredRes.status).toBe(403);
    expect(await expiredRes.text()).toContain('Invalid or Expired Action Link');
  });

  it('executes confirm_slot, release_slot, confirm_price, and mark_paid via signed GET URLs', async () => {
    const targetDate = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
    const mockFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));

    const missingDateToken = await createSignedAdminToken(
      { action: 'confirm_slot', leadId: 'LU-NODATE' },
      SECRET,
    );
    const missingDateRes = await adminActionGet({
      request: new Request(
        `https://levelupcleaning.ca/api/admin-action?token=${encodeURIComponent(missingDateToken)}`,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(missingDateRes.status).toBe(400);

    const badDateToken = await createSignedAdminToken(
      { action: 'confirm_slot', leadId: 'LU-BADDATE', date: 'not-a-date', window: 'morning' },
      SECRET,
    );
    const badDateRes = await adminActionGet({
      request: new Request(
        `https://levelupcleaning.ca/api/admin-action?token=${encodeURIComponent(badDateToken)}`,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(badDateRes.status).toBe(400);

    const confirmToken = await createSignedAdminToken(
      {
        action: 'confirm_slot',
        leadId: 'LU-CONF1',
        date: targetDate,
        window: 'morning',
        name: 'Jordan',
        phone: '(780) 710-1503',
      },
      SECRET,
    );
    const confirmRes = await adminActionGet({
      request: new Request(
        `https://levelupcleaning.ca/api/admin-action?token=${encodeURIComponent(confirmToken)}`,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_TOKEN: 'bot_tok' },
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(confirmRes.status).toBe(200);
    const confirmHtml = await confirmRes.text();
    expect(confirmHtml).toContain('Appointment Window Locked');
    expect(confirmHtml).toContain('Send Client Confirmation SMS');

    const confirmNoPhoneToken = await createSignedAdminToken(
      {
        action: 'confirm_slot',
        leadId: 'LU-CONF2',
        date: targetDate,
        window: 'afternoon',
      },
      SECRET,
    );
    const confirmNoPhoneRes = await adminActionGet({
      request: new Request(
        `https://levelupcleaning.ca/api/admin-action?token=${encodeURIComponent(confirmNoPhoneToken)}`,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(confirmNoPhoneRes.status).toBe(200);

    const missingReleaseToken = await createSignedAdminToken(
      { action: 'release_slot', leadId: 'LU-NOREL' },
      SECRET,
    );
    const missingReleaseRes = await adminActionGet({
      request: new Request(
        `https://levelupcleaning.ca/api/admin-action?token=${encodeURIComponent(missingReleaseToken)}`,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(missingReleaseRes.status).toBe(400);

    const throwingTelegramFetch = vi.fn(async () => {
      throw new Error('Telegram unreachable');
    });
    const releaseToken = await createSignedAdminToken(
      { action: 'release_slot', leadId: 'LU-REL1', date: targetDate, window: 'full_day' },
      SECRET,
    );
    const releaseRes = await adminActionGet({
      request: new Request(
        `https://levelupcleaning.ca/api/admin-action?token=${encodeURIComponent(releaseToken)}`,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_TOKEN: 'bot_tok' },
      fetchImpl: throwingTelegramFetch as unknown as typeof fetch,
    });
    expect(releaseRes.status).toBe(200);
    expect(await releaseRes.text()).toContain('Appointment Window Re-Opened');

    const priceToken = await createSignedAdminToken(
      {
        action: 'confirm_price',
        leadId: 'LU-PRC1',
        amountCad: 335,
        name: 'Olena',
        phone: '(780) 710-1503',
      },
      SECRET,
    );
    const priceRes = await adminActionGet({
      request: new Request(
        `https://levelupcleaning.ca/api/admin-action?token=${encodeURIComponent(priceToken)}`,
      ),
      env: { ADMIN_DASHBOARD_SECRET: SECRET },
    });
    expect(priceRes.status).toBe(200);
    const priceHtml = await priceRes.text();
    expect(priceHtml).toContain('$335 CAD');
    expect(priceHtml).toContain('Open Pre-Filled SMS');

    const paidLiveToken = await createSignedAdminToken(
      {
        action: 'mark_paid',
        leadId: 'LU-PAID1',
        amountCad: 285,
        service: 'move_out',
      },
      SECRET,
    );
    const paidLiveRes = await adminActionGet({
      request: new Request(
        `https://levelupcleaning.ca/api/admin-action?token=${encodeURIComponent(paidLiveToken)}`,
      ),
      env: {
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        TELEGRAM_BOT_TOKEN: 'bot_tok',
        META_PIXEL_ID: 'px1',
        META_CAPI_TOKEN: 'capi1',
      },
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    expect(paidLiveRes.status).toBe(200);
    expect(await paidLiveRes.text()).toContain('synced as a Purchase conversion to Meta CAPI');

    const paidDemoToken = await createSignedAdminToken(
      { action: 'mark_paid', leadId: 'LU-PAID2' },
      SECRET,
    );
    const paidDemoRes = await adminActionGet({
      request: new Request(
        `https://levelupcleaning.ca/api/admin-action?token=${encodeURIComponent(paidDemoToken)}`,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(paidDemoRes.status).toBe(200);
    expect(await paidDemoRes.text()).toContain('Meta CAPI credentials not configured');
  });

  it('authenticates POST dashboard actions (list, set_slot) and rejects bad auth/body', async () => {
    const postReq = (body: string, secret?: string) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (secret !== undefined) headers['X-Admin-Secret'] = secret;
      return new Request('https://levelupcleaning.ca/api/admin-action', {
        method: 'POST',
        headers,
        body,
      });
    };

    expect(
      (await adminActionPost({ request: postReq('{}', SECRET), env: {} })).status,
    ).toBe(401);
    expect(
      (
        await adminActionPost({
          request: postReq('{}'),
          env: { ADMIN_DASHBOARD_SECRET: SECRET },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await adminActionPost({
          request: postReq('{}', 'wrong_secret'),
          env: { ADMIN_DASHBOARD_SECRET: SECRET },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await adminActionPost({
          request: postReq('{bad-json', SECRET),
          env: { ADMIN_DASHBOARD_SECRET: SECRET },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await adminActionPost({
          request: postReq('[]', SECRET),
          env: { ADMIN_DASHBOARD_SECRET: SECRET },
        })
      ).status,
    ).toBe(400);

    const listRes = await adminActionPost({
      request: postReq(JSON.stringify({ action: 'list' }), SECRET),
      env: { ADMIN_DASHBOARD_SECRET: SECRET },
    });
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.ok).toBe(true);
    expect(listJson.schedule.days).toHaveLength(45);

    const badSlotRes = await adminActionPost({
      request: postReq(
        JSON.stringify({ action: 'set_slot', date: 'bad', window: 'morning', state: 'booked' }),
        SECRET,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(badSlotRes.status).toBe(400);

    const targetDate = listJson.schedule.days[3].date;
    const setRes = await adminActionPost({
      request: postReq(
        JSON.stringify({
          action: 'set_slot',
          date: targetDate,
          window: 'full_day',
          state: 'booked',
          leadId: 'LU-DASH1',
        }),
        SECRET,
      ),
      env: { ADMIN_DASHBOARD_SECRET: SECRET },
    });
    expect(setRes.status).toBe(200);
    const setJson = await setRes.json();
    const updatedDay = setJson.schedule.days.find((d: { date: string }) => d.date === targetDate);
    expect(updatedDay.morning.state).toBe('booked');
    expect(updatedDay.afternoon.state).toBe('booked');

    const unsupportedRes = await adminActionPost({
      request: postReq(JSON.stringify({ action: 'unknown' }), SECRET),
      env: { ADMIN_DASHBOARD_SECRET: SECRET },
    });
    expect(unsupportedRes.status).toBe(400);
  });
});

describe('functions/api/lead.ts — CORS preflight, 409 slot conflicts, and POST lead endpoint', () => {
  const validPayload = {
    name: 'Alex Mercer',
    phone: '(780) 710-1503',
    email: 'alex@example.ca',
    postalCode: 'T6W 1A2',
    caslSmsConsent: true,
    quoteInput: {
      mode: 'flat_rate',
      service: 'move_out',
      bedrooms: 2,
      bathrooms: 2,
    },
  };

  beforeEach(() => {
    resetMemoryCalendarStore();
  });

  it('handles OPTIONS CORS preflight with 204', async () => {
    const res = await leadOptions();
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://levelupcleaning.ca');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('returns 400 on oversized content-length, malformed JSON, and invalid payload', async () => {
    const oversizedReq = new Request('https://levelupcleaning.ca/api/lead', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '9000000',
      },
      body: '{}',
    });
    const oversizedRes = await leadPost({ request: oversizedReq, env: {} });
    expect(oversizedRes.status).toBe(400);
    expect((await oversizedRes.json()).error).toContain('exceeds maximum');

    const badJsonReq = new Request('https://levelupcleaning.ca/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-valid-json',
    });
    const badJsonRes = await leadPost({ request: badJsonReq, env: {} });
    expect(badJsonRes.status).toBe(400);
    expect((await badJsonRes.json()).error).toBe('Malformed JSON body.');

    const invalidDemoReq = new Request('https://levelupcleaning.ca/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validPayload, caslSmsConsent: false }),
    });
    const invalidDemoRes = await leadPost({ request: invalidDemoReq, env: {} });
    expect(invalidDemoRes.status).toBe(400);
    const invalidDemoBody = await invalidDemoRes.json();
    expect(invalidDemoBody.mode).toBe('demo');

    const invalidLiveReq = new Request('https://levelupcleaning.ca/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validPayload, caslSmsConsent: false }),
    });
    const invalidLiveRes = await leadPost({
      request: invalidLiveReq,
      env: { TELEGRAM_BOT_TOKEN: 'tok' },
    });
    expect(invalidLiveRes.status).toBe(400);
    expect((await invalidLiveRes.json()).mode).toBe('live');

    const invalidCapiLiveReq = new Request('https://levelupcleaning.ca/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validPayload, caslSmsConsent: false }),
    });
    const invalidCapiLiveRes = await leadPost({
      request: invalidCapiLiveReq,
      env: { META_PIXEL_ID: 'px1', META_CAPI_TOKEN: 'tok1' },
    });
    expect(invalidCapiLiveRes.status).toBe(400);
    expect((await invalidCapiLiveRes.json()).mode).toBe('live');
  });

  it('returns 200 LeadSubmissionResult and returns 409 when preferredSlot is already booked', async () => {
    const req1 = new Request('https://levelupcleaning.ca/api/lead', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '198.51.100.12',
        'User-Agent': 'VitestAgent/1.0',
        Referer: 'https://levelupcleaning.ca/lp/move-out',
      },
      body: JSON.stringify(validPayload),
    });

    const res1 = await leadPost({ request: req1, env: {} });
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.ok).toBe(true);
    expect(json1.leadId).toMatch(/^LU-/);
    expect(json1.finalPreTaxCad).toBe(285);

    const req2 = new Request('https://levelupcleaning.ca/api/lead', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.5, 10.0.0.1',
      },
      body: JSON.stringify(validPayload),
    });
    const res2 = await leadPost({ request: req2, env: {} });
    expect(res2.status).toBe(200);

    const bookedDate = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await setSlotStateAdmin(bookedDate, 'morning', 'booked', 'LU-TAKEN');

    const conflictReq = new Request('https://levelupcleaning.ca/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...validPayload,
        preferredSlot: { date: bookedDate, window: 'morning' },
      }),
    });
    const conflictRes = await leadPost({ request: conflictReq, env: {} });
    expect(conflictRes.status).toBe(409);
    const conflictJson = await conflictRes.json();
    expect(conflictJson.ok).toBe(false);
    expect(conflictJson.error).toContain('just booked');
  });
});

describe('functions/api/slots.ts — KV, calendar store sync, and fallback open-slots endpoint', () => {
  beforeEach(() => {
    resetMemoryCalendarStore();
  });

  it('reads KV override, falls back to calendar schedule when KV key missing or overrides exist, and recovers from errors', async () => {
    const req = new Request('https://levelupcleaning.ca/api/slots');

    const kvHitRes = await slotsGet({
      request: req,
      env: {
        LEVELUP_KV: {
          get: vi.fn(async () => '5'),
          put: vi.fn(async () => {}),
        },
      },
    });
    expect(kvHitRes.status).toBe(200);
    expect(kvHitRes.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await kvHitRes.json()).toEqual({
      slots: 5,
      label: '5 open slots available in Edmonton this week',
      urgent: false,
    });

    const kvMissRes = await slotsGet({
      request: req,
      env: {
        LEVELUP_KV: {
          get: vi.fn(async () => null),
          put: vi.fn(async () => {}),
        },
      },
    });
    expect(kvMissRes.status).toBe(200);
    expect((await kvMissRes.json()).slots).toBe(9);

    const kvAbsentRes = await slotsGet({ request: req });
    expect(kvAbsentRes.status).toBe(200);
    expect((await kvAbsentRes.json()).slots).toBe(3);

    const schedule = await getCalendarSchedule();
    const targetDate = schedule.days[0].date;
    await setSlotStateAdmin(targetDate, 'full_day', 'booked', 'LU-MEM');
    const memOverrideRes = await slotsGet({ request: req });
    expect(memOverrideRes.status).toBe(200);
    expect((await memOverrideRes.json()).slots).toBe(8);

    const kvErrorRes = await slotsGet({
      request: req,
      env: {
        LEVELUP_KV: {
          get: vi.fn(async () => {
            throw new Error('KV unavailable');
          }),
          put: vi.fn(async () => {}),
        },
      },
    });
    expect(kvErrorRes.status).toBe(200);
    expect((await kvErrorRes.json()).slots).toBe(3);
  });
});

describe('functions/api/telegram-callback.ts — Secret token, paid Purchase CAPI, and /slots', () => {
  const SECRET = 'whsec_levelup_test_secret';

  function buildReq(body: string, tokenHeader?: string): Request {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tokenHeader !== undefined) {
      headers['X-Telegram-Bot-Api-Secret-Token'] = tokenHeader;
    }
    return new Request('https://levelupcleaning.ca/api/telegram-callback', {
      method: 'POST',
      headers,
      body,
    });
  }

  it('enforces secret token authentication (401/403) and rejects malformed JSON (400)', async () => {
    const r1 = await telegramPost({ request: buildReq('{}', SECRET), env: {} });
    expect(r1.status).toBe(401);

    const r2 = await telegramPost({
      request: buildReq('{}'),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(r2.status).toBe(401);

    const r3 = await telegramPost({
      request: buildReq('{}', 'short'),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(r3.status).toBe(403);

    const sameLenWrong = 'X'.repeat(SECRET.length);
    const r4 = await telegramPost({
      request: buildReq('{}', sameLenWrong),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(r4.status).toBe(403);

    const r5 = await telegramPost({
      request: buildReq('{bad', SECRET),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(r5.status).toBe(400);
  });

  it('handles callback_query: unauthorized sender, malformed data, invalid amount, and valid paid Purchase', async () => {
    const unauth = await telegramPost({
      request: buildReq(
        JSON.stringify({
          callback_query: { id: 'cb1', from: { id: 999999 }, data: 'paid:LU-1:310:move_out' },
        }),
        SECRET,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(unauth.status).toBe(403);

    const missingFrom = await telegramPost({
      request: buildReq(
        JSON.stringify({ callback_query: { id: 'cb1', data: 'paid:LU-1:310:move_out' } }),
        SECRET,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(missingFrom.status).toBe(403);

    const badData = await telegramPost({
      request: buildReq(
        JSON.stringify({
          callback_query: { id: 'cb1', from: { id: 633982504 }, data: 'unknown:payload' },
        }),
        SECRET,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(badData.status).toBe(400);

    const missingData = await telegramPost({
      request: buildReq(
        JSON.stringify({ callback_query: { id: 'cb1', from: { id: 633982504 } } }),
        SECRET,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(missingData.status).toBe(400);

    const zeroAmt = await telegramPost({
      request: buildReq(
        JSON.stringify({
          callback_query: { id: 'cb1', from: { id: 633982504 }, data: 'paid:LU-1:0:move_out' },
        }),
        SECRET,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(zeroAmt.status).toBe(400);

    const hugeAmt = await telegramPost({
      request: buildReq(
        JSON.stringify({
          callback_query: { id: 'cb1', from: { id: 633982504 }, data: 'paid:LU-1:25000:move_out' },
        }),
        SECRET,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(hugeAmt.status).toBe(400);

    const calls: string[] = [];
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response('{"ok":true}', { status: 200 });
    });

    const validPaid = await telegramPost({
      request: buildReq(
        JSON.stringify({
          callback_query: {
            id: 'cb_ok_1',
            from: { id: 633982504 },
            data: 'paid:LU-ABCD12:335.50:move_out',
          },
        }),
        SECRET,
      ),
      env: {
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        TELEGRAM_BOT_TOKEN: 'bot_tok',
        META_PIXEL_ID: 'px1',
        META_CAPI_TOKEN: 'capi1',
      },
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(validPaid.status).toBe(200);
    const paidJson = await validPaid.json();
    expect(paidJson).toEqual({
      ok: true,
      action: 'purchase_recorded',
      leadId: 'LU-ABCD12',
      amount: 335.5,
      service: 'move_out',
      capiDispatched: true,
    });
    expect(calls.some((u) => u.includes('graph.facebook.com'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/answerCallbackQuery'))).toBe(true);

    const throwingCallbackFetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/answerCallbackQuery')) {
        throw new Error('Telegram toast timeout');
      }
      return new Response('{"ok":true}', { status: 200 });
    });
    const secondAdminRes = await telegramPost({
      request: buildReq(
        JSON.stringify({
          callback_query: {
            id: 'cb_ok_2',
            from: { id: '332623386' },
            data: 'paid:LU-SECOND:210:deep_clean',
          },
        }),
        SECRET,
      ),
      env: {
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        TELEGRAM_BOT_TOKEN: 'bot_tok',
      },
      fetchImpl: throwingCallbackFetch as unknown as typeof fetch,
    });
    expect(secondAdminRes.status).toBe(200);
  });

  it('handles /slots admin command, KV put + reply, and ignored updates', async () => {
    const unauthMsg = await telegramPost({
      request: buildReq(
        JSON.stringify({ message: { from: { id: 12345 }, chat: { id: 12345 }, text: '/slots 4' } }),
        SECRET,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(unauthMsg.status).toBe(403);

    const missingSenderMsg = await telegramPost({
      request: buildReq(JSON.stringify({ message: { chat: { id: 12345 } } }), SECRET),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(missingSenderMsg.status).toBe(403);

    const textlessMsg = await telegramPost({
      request: buildReq(
        JSON.stringify({ message: { from: { id: 633982504 }, chat: { id: 633982504 } } }),
        SECRET,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(textlessMsg.status).toBe(200);
    const normalMsg = await telegramPost({
      request: buildReq(
        JSON.stringify({
          message: { from: { id: 633982504 }, chat: { id: 633982504 }, text: 'Great job today!' },
        }),
        SECRET,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(normalMsg.status).toBe(200);
    expect(await normalMsg.json()).toEqual({ ok: true, action: 'ignored' });

    const badSlots = await telegramPost({
      request: buildReq(
        JSON.stringify({
          message: { from: { id: 633982504 }, chat: { id: 633982504 }, text: '/slots 15' },
        }),
        SECRET,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(badSlots.status).toBe(400);

    const kvPut = vi.fn(async () => {});
    const replyFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const okSlots = await telegramPost({
      request: buildReq(
        JSON.stringify({
          message: { from: { id: 633982504 }, chat: { id: 633982504 }, text: '/slots 5' },
        }),
        SECRET,
      ),
      env: {
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        TELEGRAM_BOT_TOKEN: 'bot_tok',
        LEVELUP_KV: { get: vi.fn(async () => '5'), put: kvPut },
      },
      fetchImpl: replyFetch as unknown as typeof fetch,
    });
    expect(okSlots.status).toBe(200);
    expect(await okSlots.json()).toEqual({
      ok: true,
      action: 'slots_updated',
      slots: 5,
      kvUpdated: true,
    });
    expect(kvPut).toHaveBeenCalledWith('weekly_open_slots', '5');
    expect(replyFetch).toHaveBeenCalledTimes(1);

    const errReplyFetch = vi.fn(async () => {
      throw new Error('Reply network fail');
    });
    const noKvSlots = await telegramPost({
      request: buildReq(
        JSON.stringify({
          message: {
            from: { id: 332623386 },
            chat: { id: 332623386 },
            text: '/slots@LevelUpBot 0',
          },
        }),
        SECRET,
      ),
      env: {
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        TELEGRAM_BOT_TOKEN: 'bot_tok',
      },
      fetchImpl: errReplyFetch as unknown as typeof fetch,
    });
    expect(noKvSlots.status).toBe(200);
    expect(await noKvSlots.json()).toEqual({
      ok: true,
      action: 'slots_updated',
      slots: 0,
      kvUpdated: false,
    });

    const emptyUpdate = await telegramPost({
      request: buildReq('{}', SECRET),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(emptyUpdate.status).toBe(200);
    expect(await emptyUpdate.json()).toEqual({ ok: true, action: 'ignored' });
  });
});
