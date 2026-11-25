import { describe, expect, it, vi } from 'vitest';
import {
  onRequestOptions as leadOptions,
  onRequestPost as leadPost,
} from '../functions/api/lead';
import { onRequestGet as slotsGet } from '../functions/api/slots';
import { onRequestPost as telegramPost } from '../functions/api/telegram-callback';

describe('functions/api/lead.ts — CORS preflight and POST lead endpoint', () => {
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

  it('returns 200 LeadSubmissionResult on valid submission with CF/X-Forwarded-For/bare headers', async () => {
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
    expect(json1.finalPreTaxCad).toBe(285); // 310 + 25 = 335 (>=300 tier => -50) = 285

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

    const req3 = new Request('https://levelupcleaning.ca/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload),
    });
    const res3 = await leadPost({ request: req3, env: {} });
    expect(res3.status).toBe(200);
  });
});

describe('functions/api/slots.ts — KV open-slots endpoint', () => {
  it('returns KV hit value, falls back to default when KV is absent, and recovers from KV errors', async () => {
    const req = new Request('https://levelupcleaning.ca/api/slots');

    // KV hit
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

    // KV absent
    const kvAbsentRes = await slotsGet({ request: req });
    expect(kvAbsentRes.status).toBe(200);
    expect((await kvAbsentRes.json()).slots).toBe(3);

    // KV throws error
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
    // Missing env secret -> 401
    const r1 = await telegramPost({ request: buildReq('{}', SECRET), env: {} });
    expect(r1.status).toBe(401);

    // Missing request header -> 401
    const r2 = await telegramPost({
      request: buildReq('{}'),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(r2.status).toBe(401);

    // Wrong length token -> 403
    const r3 = await telegramPost({
      request: buildReq('{}', 'short'),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(r3.status).toBe(403);

    // Same length wrong token -> 403
    const sameLenWrong = 'X'.repeat(SECRET.length);
    const r4 = await telegramPost({
      request: buildReq('{}', sameLenWrong),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(r4.status).toBe(403);

    // Malformed JSON -> 400
    const r5 = await telegramPost({
      request: buildReq('{bad', SECRET),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(r5.status).toBe(400);
  });

  it('handles callback_query: unauthorized sender, malformed data, invalid amount, and valid paid Purchase', async () => {
    // Unauthorized sender -> 403
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

    // Missing sender id -> 403
    const missingFrom = await telegramPost({
      request: buildReq(
        JSON.stringify({ callback_query: { id: 'cb1', data: 'paid:LU-1:310:move_out' } }),
        SECRET,
      ),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(missingFrom.status).toBe(403);

    // Malformed / missing callback_data -> 400
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

    // Zero or excessive amount -> 400
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

    // Valid admin paid callback -> Meta CAPI Purchase + answerCallbackQuery
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

    // Second admin (332623386) when answerCallbackQuery throws -> still 200
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
    // Non-admin / missing-sender message -> 403
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

    // Non-command or textless message from admin -> 200 ignored
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

    // Malformed /slots command -> 400
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

    // Valid /slots 5 -> KV put + Telegram reply
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

    // /slots@BotName 0 without KV and throwing replyFetch -> non-fatal 200
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

    // Empty update object -> 200 ignored
    const emptyUpdate = await telegramPost({
      request: buildReq('{}', SECRET),
      env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    });
    expect(emptyUpdate.status).toBe(200);
    expect(await emptyUpdate.json()).toEqual({ ok: true, action: 'ignored' });
  });
});
