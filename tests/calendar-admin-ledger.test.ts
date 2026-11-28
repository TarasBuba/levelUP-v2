import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSignedAdminUrl,
  constantTimeEqual,
  createSignedAdminToken,
  verifySignedAdminToken,
} from '../src/lib/admin-signing';
import {
  AFTERNOON_TIME_RANGE,
  EDMONTON_TZ,
  MORNING_TIME_RANGE,
  getCalendarSchedule,
  getEdmontonDateKey,
  hasMemoryCalendarOverrides,
  reserveCalendarSlot,
  resetMemoryCalendarStore,
  setSlotStateAdmin,
} from '../src/lib/calendar-store';
import {
  dispatchGoogleSheetsLead,
  saveLeadRecord,
  sendCustomerConfirmationEmail,
  type LeadLedgerRecord,
} from '../src/lib/lead-ledger';
import { calculateQuote } from '../src/lib/pricing';
import {
  initAdTracking,
  trackClientLeadConversion,
  trackClientViewContent,
} from '../src/lib/tracking';
import type { LeadSubmissionPayload, SlotState, SlotWindow } from '../src/types/contracts';

async function signSegment(segment: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(segment)));
  let bin = '';
  for (let i = 0; i < sig.length; i += 1) {
    bin += String.fromCharCode(sig[i]);
  }
  return globalThis.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeBase64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

describe('calendar-store.ts — 45-day Edmonton schedule, slot reservations, and multi-backend storage', () => {
  const fixedNow = new Date('2026-11-28T18:00:00Z');

  beforeEach(() => {
    resetMemoryCalendarStore();
  });

  afterEach(() => {
    resetMemoryCalendarStore();
  });

  it('computes Edmonton date keys and builds deterministic 45-day memory fallback schedules', async () => {
    expect(EDMONTON_TZ).toBe('America/Edmonton');
    expect(MORNING_TIME_RANGE).toContain('8:30 AM');
    expect(AFTERNOON_TIME_RANGE).toContain('1:30 PM');
    expect(getEdmontonDateKey(fixedNow)).toBe('2026-11-28');
    expect(getEdmontonDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(hasMemoryCalendarOverrides()).toBe(false);

    const schedule = await getCalendarSchedule(undefined, { now: fixedNow });
    expect(schedule.storageBackend).toBe('memory');
    expect(schedule.days).toHaveLength(45);
    expect(schedule.days[0].date).toBe('2026-11-28');
    expect(schedule.days[0].isWeekend).toBe(true);
    expect(schedule.days[0].statusSummary).toBe('available');
    expect(schedule.days[1].morning.state).toBe('booked');
    expect(schedule.days[1].afternoon.state).toBe('available');
    expect(schedule.days[1].statusSummary).toBe('one_left');
    expect(schedule.days[2].afternoon.state).toBe('booked');
    expect(schedule.days[4].morning.state).toBe('booked');
    expect(schedule.days[6].afternoon.state).toBe('booked');
    expect(schedule.weeklyOpenSlots).toBe(10);

    const clampedShort = await getCalendarSchedule(undefined, { now: fixedNow, daysCount: 0 });
    expect(clampedShort.days).toHaveLength(1);
    const clampedLong = await getCalendarSchedule(undefined, { now: fixedNow, daysCount: 150 });
    expect(clampedLong.days).toHaveLength(90);
  });

  it('reserves morning, afternoon, and full_day slots while rejecting conflicts and invalid inputs', async () => {
    const openDate = '2026-12-01';
    const fullDayDate = '2026-12-03';

    const badDate = await reserveCalendarSlot(
      { date: '2026/12/01', window: 'morning' },
      'LU-BAD1',
      undefined,
      { now: fixedNow },
    );
    expect(badDate.ok).toBe(false);
    expect(badDate.reason).toContain('Invalid booking date');

    const outOfRange = await reserveCalendarSlot(
      { date: '2028-01-01', window: 'morning' },
      'LU-FAR',
      undefined,
      { now: fixedNow },
    );
    expect(outOfRange.ok).toBe(false);
    expect(outOfRange.reason).toContain('outside the 45-day');

    const badWindow = await reserveCalendarSlot(
      { date: openDate, window: 'evening' as SlotWindow },
      'LU-WIN',
      undefined,
      { now: fixedNow },
    );
    expect(badWindow.ok).toBe(false);
    expect(badWindow.reason).toContain('Unsupported slot window');

    const morningRes = await reserveCalendarSlot(
      { date: openDate, window: 'morning' },
      'LU-MORN1',
      undefined,
      { now: fixedNow },
    );
    expect(morningRes.ok).toBe(true);
    expect(hasMemoryCalendarOverrides()).toBe(true);
    const dayAfterMorning = morningRes.schedule.days.find((d) => d.date === openDate);
    expect(dayAfterMorning?.morning.state).toBe('pending');
    expect(dayAfterMorning?.morning.leadId).toBe('LU-MORN1');

    const morningConflict = await reserveCalendarSlot(
      { date: openDate, window: 'morning' },
      'LU-MORN2',
      undefined,
      { now: fixedNow },
    );
    expect(morningConflict.ok).toBe(false);
    expect(morningConflict.reason).toContain('Morning window is already booked');

    const fullDayOverlap = await reserveCalendarSlot(
      { date: openDate, window: 'full_day' },
      'LU-FULL1',
      undefined,
      { now: fixedNow },
    );
    expect(fullDayOverlap.ok).toBe(false);
    expect(fullDayOverlap.reason).toContain('Full-day slot requires both');

    const afternoonRes = await reserveCalendarSlot(
      { date: openDate, window: 'afternoon' },
      '   ',
      undefined,
      { now: fixedNow },
    );
    expect(afternoonRes.ok).toBe(true);
    const dayAfterBoth = afternoonRes.schedule.days.find((d) => d.date === openDate);
    expect(dayAfterBoth?.statusSummary).toBe('pending');
    expect(dayAfterBoth?.afternoon.leadId).toBeUndefined();

    const afternoonConflict = await reserveCalendarSlot(
      { date: openDate, window: 'afternoon' },
      'LU-AFT2',
      undefined,
      { now: fixedNow },
    );
    expect(afternoonConflict.ok).toBe(false);
    expect(afternoonConflict.reason).toContain('Afternoon window is already booked');

    const fullDayOk = await reserveCalendarSlot(
      { date: fullDayDate, window: 'full_day' },
      'LU-FULLOK',
      undefined,
      { now: fixedNow },
    );
    expect(fullDayOk.ok).toBe(true);
    const fullDayRecord = fullDayOk.schedule.days.find((d) => d.date === fullDayDate);
    expect(fullDayRecord?.morning.state).toBe('pending');
    expect(fullDayRecord?.afternoon.state).toBe('pending');
    expect(fullDayRecord?.fullDayAvailable).toBe(false);
  });

  it('supports setSlotStateAdmin for morning, afternoon, full_day, available reset, and invalid inputs', async () => {
    const targetDate = '2026-12-01';

    const badAdmin = await setSlotStateAdmin(
      'bad-date',
      'morning',
      'booked',
      'LU-1',
      undefined,
      { now: fixedNow },
    );
    expect(badAdmin.ok).toBe(false);

    const badState = await setSlotStateAdmin(
      targetDate,
      'morning',
      'closed' as SlotState,
      'LU-1',
      undefined,
      { now: fixedNow },
    );
    expect(badState.ok).toBe(false);

    const bookedFull = await setSlotStateAdmin(
      targetDate,
      'full_day',
      'booked',
      'LU-ADMIN1',
      undefined,
      { now: fixedNow },
    );
    expect(bookedFull.ok).toBe(true);
    const dayBooked = bookedFull.schedule.days.find((d) => d.date === targetDate);
    expect(dayBooked?.statusSummary).toBe('booked');
    expect(dayBooked?.morning.leadId).toBe('LU-ADMIN1');
    expect(dayBooked?.afternoon.leadId).toBe('LU-ADMIN1');

    const reopenMorning = await setSlotStateAdmin(
      targetDate,
      'morning',
      'available',
      'LU-IGNORED',
      undefined,
      { now: fixedNow },
    );
    expect(reopenMorning.ok).toBe(true);
    const dayHalf = reopenMorning.schedule.days.find((d) => d.date === targetDate);
    expect(dayHalf?.morning.state).toBe('available');
    expect(dayHalf?.morning.leadId).toBeUndefined();
    expect(dayHalf?.afternoon.state).toBe('booked');

    const pendingAfternoon = await setSlotStateAdmin(
      targetDate,
      'afternoon',
      'pending',
      undefined,
      undefined,
      { now: fixedNow },
    );
    expect(pendingAfternoon.ok).toBe(true);
    const dayPending = pendingAfternoon.schedule.days.find((d) => d.date === targetDate);
    expect(dayPending?.afternoon.state).toBe('pending');
    expect(dayPending?.afternoon.leadId).toBeUndefined();
  });

  it('persists and recovers cleanly across Upstash REST, Vercel Blob REST, and Cloudflare KV', async () => {
    const upstashEnv = {
      UPSTASH_REDIS_REST_URL: 'https://redis.upstash.example/',
      UPSTASH_REDIS_REST_TOKEN: 'upstash_tok',
    };

    const upstashReadPayload = JSON.stringify({
      days: {
        '2026-11-29': {
          morning: { state: 'booked', leadId: 'LU-UP1' },
          afternoon: { state: 'invalid_state' },
        },
        'not-a-date': { morning: { state: 'booked' } },
        '2026-11-30': 'not-an-object',
      },
    });
    const upstashFetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/get/')) {
        return new Response(JSON.stringify({ result: upstashReadPayload }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    });

    const upstashSched = await getCalendarSchedule(upstashEnv, {
      now: fixedNow,
      fetchImpl: upstashFetch as unknown as typeof fetch,
    });
    expect(upstashSched.storageBackend).toBe('upstash');
    expect(upstashSched.days[1].morning.state).toBe('booked');
    expect(upstashSched.days[1].morning.leadId).toBe('LU-UP1');
    expect(upstashSched.days[1].afternoon.state).toBe('available');

    const upstashWrite = await setSlotStateAdmin(
      '2026-11-29',
      'afternoon',
      'booked',
      'LU-UP2',
      upstashEnv,
      { now: fixedNow, fetchImpl: upstashFetch as unknown as typeof fetch },
    );
    expect(upstashWrite.ok).toBe(true);
    expect(upstashFetch).toHaveBeenCalledTimes(3);

    const upstashEdgeFetch = vi.fn(async () => new Response(JSON.stringify({ result: '' }), { status: 200 }));
    const upstashEmpty = await getCalendarSchedule(upstashEnv, {
      now: fixedNow,
      fetchImpl: upstashEdgeFetch as unknown as typeof fetch,
    });
    expect(upstashEmpty.days[0].morning.state).toBe('available');

    const upstashBadJsonFetch = vi.fn(
      async () => new Response(JSON.stringify({ result: '{bad-json' }), { status: 200 }),
    );
    const upstashBadJson = await getCalendarSchedule(upstashEnv, {
      now: fixedNow,
      fetchImpl: upstashBadJsonFetch as unknown as typeof fetch,
    });
    expect(upstashBadJson.days[0].morning.state).toBe('available');

    const upstashObjFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: {
              days: { '2026-11-28': { morning: { state: 'pending' } } },
              updatedAt: '2026-11-28T00:00:00.000Z',
            },
          }),
          { status: 200 },
        ),
    );
    const upstashObj = await getCalendarSchedule(upstashEnv, {
      now: fixedNow,
      fetchImpl: upstashObjFetch as unknown as typeof fetch,
    });
    expect(upstashObj.days[0].morning.state).toBe('pending');

    const upstashFailHttp = vi.fn(async () => new Response('err', { status: 500 }));
    await expect(
      getCalendarSchedule(upstashEnv, {
        now: fixedNow,
        fetchImpl: upstashFailHttp as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ storageBackend: 'upstash' });

    const upstashThrow = vi.fn(async () => {
      throw new Error('Upstash down');
    });
    const upstashRecovered = await setSlotStateAdmin(
      '2026-11-28',
      'morning',
      'booked',
      'LU-ERR',
      upstashEnv,
      { now: fixedNow, fetchImpl: upstashThrow as unknown as typeof fetch },
    );
    expect(upstashRecovered.ok).toBe(true);

    const blobEnv = { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_tok' };
    const blobFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'PUT') {
        return new Response(JSON.stringify({ url: 'https://blob.example/cal.json' }), { status: 200 });
      }
      if (u.includes('?prefix=')) {
        return new Response(
          JSON.stringify({
            blobs: [
              {
                pathname: 'levelup/calendar-schedule.json',
                url: 'https://blob.example/levelup/calendar-schedule.json',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          days: { '2026-11-28': { afternoon: { state: 'booked', leadId: 'LU-BLOB1' } } },
        }),
        { status: 200 },
      );
    });

    const blobSched = await getCalendarSchedule(blobEnv, {
      now: fixedNow,
      fetchImpl: blobFetch as unknown as typeof fetch,
    });
    expect(blobSched.storageBackend).toBe('blob');
    expect(blobSched.days[0].afternoon.state).toBe('booked');
    expect(blobSched.days[0].afternoon.leadId).toBe('LU-BLOB1');

    const blobWrite = await setSlotStateAdmin(
      '2026-11-28',
      'morning',
      'booked',
      'LU-BLOB2',
      blobEnv,
      { now: fixedNow, fetchImpl: blobFetch as unknown as typeof fetch },
    );
    expect(blobWrite.ok).toBe(true);

    const blobListFail = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(
      getCalendarSchedule(blobEnv, { now: fixedNow, fetchImpl: blobListFail as unknown as typeof fetch }),
    ).resolves.toMatchObject({ storageBackend: 'blob' });

    const blobNoMatch = vi.fn(async () => new Response(JSON.stringify({ blobs: [] }), { status: 200 }));
    await expect(
      getCalendarSchedule(blobEnv, { now: fixedNow, fetchImpl: blobNoMatch as unknown as typeof fetch }),
    ).resolves.toMatchObject({ storageBackend: 'blob' });

    const blobDataFail = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('?prefix=')) {
        return new Response(
          JSON.stringify({
            blobs: [{ pathname: 'levelup/calendar-schedule.json', url: 'https://blob.example/data' }],
          }),
          { status: 200 },
        );
      }
      return new Response('missing', { status: 404 });
    });
    await expect(
      getCalendarSchedule(blobEnv, { now: fixedNow, fetchImpl: blobDataFail as unknown as typeof fetch }),
    ).resolves.toMatchObject({ storageBackend: 'blob' });

    const blobThrow = vi.fn(async () => {
      throw new Error('Blob network failure');
    });
    await expect(
      setSlotStateAdmin('2026-11-28', 'morning', 'booked', 'LU-BERR', blobEnv, {
        now: fixedNow,
        fetchImpl: blobThrow as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ ok: true });

    const kvPut = vi.fn(async () => {});
    const kvEnv = {
      LEVELUP_KV: {
        get: vi.fn(async () =>
          JSON.stringify({
            days: { '2026-11-28': { morning: { state: 'booked', leadId: 'LU-KV1' } } },
          }),
        ),
        put: kvPut,
      },
    };
    const kvSched = await getCalendarSchedule(kvEnv, { now: fixedNow });
    expect(kvSched.storageBackend).toBe('kv');
    expect(kvSched.days[0].morning.leadId).toBe('LU-KV1');

    const kvWrite = await setSlotStateAdmin('2026-11-28', 'afternoon', 'booked', 'LU-KV2', kvEnv, {
      now: fixedNow,
    });
    expect(kvWrite.ok).toBe(true);
    expect(kvPut).toHaveBeenCalledWith('weekly_open_slots', expect.any(String));

    const kvBrokenEnv = {
      LEVELUP_KV: {
        get: vi.fn(async () => {
          throw new Error('KV read error');
        }),
        put: vi.fn(async () => {
          throw new Error('KV write error');
        }),
      },
    };
    await expect(
      setSlotStateAdmin('2026-11-28', 'morning', 'booked', 'LU-KVERR', kvBrokenEnv, {
        now: fixedNow,
      }),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('admin-signing.ts — HMAC-SHA256 tokens, constant-time compare, and signed admin URLs', () => {
  const SECRET = 'super_secret_admin_signing_key_2026';

  it('compares strings in constant time across equal, unequal, different-length, and nullish values', async () => {
    expect(await constantTimeEqual('abc123', 'abc123')).toBe(true);
    expect(await constantTimeEqual('abc123', 'abc124')).toBe(false);
    expect(await constantTimeEqual('short', 'much_longer_value')).toBe(false);
    expect(await constantTimeEqual(undefined as unknown as string, '')).toBe(true);
  });

  it('creates, signs, builds URLs, and verifies valid and invalid admin action tokens', async () => {
    await expect(
      createSignedAdminToken({ action: 'confirm_slot', leadId: 'LU-1' }, '   '),
    ).rejects.toThrow('Admin signing secret is required.');

    const nowUnix = 1_800_000_000;
    const tokenWithExp = await createSignedAdminToken(
      {
        action: 'confirm_slot',
        leadId: 'LU-100',
        date: '2026-12-01',
        window: 'morning',
        exp: nowUnix + 3600,
      },
      SECRET,
    );
    const verified = await verifySignedAdminToken(tokenWithExp, SECRET, nowUnix);
    expect(verified).toEqual({
      valid: true,
      payload: {
        action: 'confirm_slot',
        leadId: 'LU-100',
        date: '2026-12-01',
        window: 'morning',
        exp: nowUnix + 3600,
      },
    });

    const defaultTtlUrl = await buildSignedAdminUrl(
      'https://levelupcleaning.ca/',
      { action: 'mark_paid', leadId: 'LU-200', amountCad: 310, service: 'move_out' },
      SECRET,
    );
    expect(defaultTtlUrl).toContain('https://levelupcleaning.ca/api/admin-action?token=');
    const parsedToken = new URL(defaultTtlUrl).searchParams.get('token')!;
    const verifiedDefault = await verifySignedAdminToken(parsedToken, SECRET);
    expect(verifiedDefault.valid).toBe(true);

    const fallbackOriginUrl = await buildSignedAdminUrl(
      '',
      { action: 'release_slot', leadId: 'LU-201', date: '2026-12-02', window: 'afternoon' },
      SECRET,
    );
    expect(fallbackOriginUrl.startsWith('https://levelupcleaning.ca/api/admin-action?token=')).toBe(
      true,
    );

    expect(await verifySignedAdminToken(tokenWithExp, '')).toEqual({
      valid: false,
      error: 'Signing secret is not configured.',
    });
    expect(await verifySignedAdminToken('no-dot-token', SECRET)).toEqual({
      valid: false,
      error: 'Malformed admin action token.',
    });
    expect(await verifySignedAdminToken('a.b.c', SECRET)).toEqual({
      valid: false,
      error: 'Malformed admin action token.',
    });
    expect(await verifySignedAdminToken('.sig', SECRET)).toEqual({
      valid: false,
      error: 'Malformed admin action token.',
    });

    const [seg, sig] = tokenWithExp.split('.');
    const tamperedSig = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
    expect(await verifySignedAdminToken(`${seg}.${tamperedSig}`, SECRET, nowUnix)).toEqual({
      valid: false,
      error: 'Invalid admin action signature.',
    });

    expect(await verifySignedAdminToken(tokenWithExp, SECRET, nowUnix + 7200)).toEqual({
      valid: false,
      error: 'Admin action link has expired.',
    });

    const corruptedPayloadSeg = 'bm90LWpzb24';
    const corruptedToken = `${corruptedPayloadSeg}.${await signSegment(corruptedPayloadSeg, SECRET)}`;
    expect(await verifySignedAdminToken(corruptedToken, SECRET, nowUnix)).toEqual({
      valid: false,
      error: 'Corrupted admin action payload.',
    });

    const arraySeg = encodeBase64UrlJson(['not', 'object']);
    expect(
      await verifySignedAdminToken(`${arraySeg}.${await signSegment(arraySeg, SECRET)}`, SECRET, nowUnix),
    ).toEqual({
      valid: false,
      error: 'Invalid admin action payload object.',
    });

    const badActionSeg = encodeBase64UrlJson({ action: 'delete_all', leadId: 'LU-1', exp: nowUnix + 60 });
    expect(
      await verifySignedAdminToken(
        `${badActionSeg}.${await signSegment(badActionSeg, SECRET)}`,
        SECRET,
        nowUnix,
      ),
    ).toEqual({
      valid: false,
      error: 'Unsupported admin action type.',
    });

    const missingLeadSeg = encodeBase64UrlJson({ action: 'mark_paid', leadId: '  ', exp: nowUnix + 60 });
    expect(
      await verifySignedAdminToken(
        `${missingLeadSeg}.${await signSegment(missingLeadSeg, SECRET)}`,
        SECRET,
        nowUnix,
      ),
    ).toEqual({
      valid: false,
      error: 'Missing lead identifier in admin token.',
    });

    const missingExpSeg = encodeBase64UrlJson({ action: 'mark_paid', leadId: 'LU-1' });
    expect(
      await verifySignedAdminToken(
        `${missingExpSeg}.${await signSegment(missingExpSeg, SECRET)}`,
        SECRET,
        nowUnix,
      ),
    ).toEqual({
      valid: false,
      error: 'Admin action link has expired.',
    });
  });
});

describe('lead-ledger.ts — Lead persistence, Google Sheets webhook, and Resend email', () => {
  const sampleRecord: LeadLedgerRecord = {
    leadId: 'LU-LEDGER1',
    createdAt: '2026-11-28T18:00:00.000Z',
    leadType: 'residential_quote',
    name: 'Jordan <Taylor>',
    phone: '(780) 710-1503',
    email: 'jordan@example.ca',
    postalCode: 'T6W',
    areaName: 'Windermere',
    service: 'move_out',
    serviceTitle: 'Move-Out / Move-In Inspection Clean',
    finalPreTaxCad: 285,
    estimatedGstCad: 14.25,
    preferredSlot: { date: '2026-12-02', window: 'morning' },
    snapPhotosCount: 0,
  };

  it('saves lead records across Upstash, Blob, KV, and gracefully returns false when unconfigured or failing', async () => {
    expect(await saveLeadRecord(sampleRecord)).toBe(false);

    const upstashOk = vi.fn(async () => new Response('{"result":"OK"}', { status: 200 }));
    expect(
      await saveLeadRecord(
        sampleRecord,
        { UPSTASH_REDIS_REST_URL: 'https://redis.example/', UPSTASH_REDIS_REST_TOKEN: 'tok' },
        upstashOk as unknown as typeof fetch,
      ),
    ).toBe(true);
    expect(upstashOk).toHaveBeenCalledTimes(2);

    const upstashThrow = vi.fn(async () => {
      throw new Error('redis err');
    });
    expect(
      await saveLeadRecord(
        sampleRecord,
        { UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'tok' },
        upstashThrow as unknown as typeof fetch,
      ),
    ).toBe(false);

    const blobOk = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(
      await saveLeadRecord(
        sampleRecord,
        { BLOB_READ_WRITE_TOKEN: 'blob_tok' },
        blobOk as unknown as typeof fetch,
      ),
    ).toBe(true);

    const blobThrow = vi.fn(async () => {
      throw new Error('blob err');
    });
    expect(
      await saveLeadRecord(
        sampleRecord,
        { BLOB_READ_WRITE_TOKEN: 'blob_tok' },
        blobThrow as unknown as typeof fetch,
      ),
    ).toBe(false);

    const kvPut = vi.fn(async () => {});
    expect(
      await saveLeadRecord(sampleRecord, { LEVELUP_KV: { get: vi.fn(), put: kvPut } }),
    ).toBe(true);
    expect(kvPut).toHaveBeenCalledWith('lead:LU-LEDGER1', expect.any(String));

    expect(
      await saveLeadRecord(sampleRecord, {
        LEVELUP_KV: {
          get: vi.fn(),
          put: vi.fn(async () => {
            throw new Error('kv fail');
          }),
        },
      }),
    ).toBe(false);
  });

  it('dispatches Google Sheets webhook and handles missing URL, HTTP error, and network failure', async () => {
    expect(await dispatchGoogleSheetsLead(sampleRecord)).toBe(false);

    const okFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    expect(
      await dispatchGoogleSheetsLead(
        sampleRecord,
        { GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/demo/exec' },
        okFetch as unknown as typeof fetch,
      ),
    ).toBe(true);

    const badFetch = vi.fn(async () => new Response('fail', { status: 500 }));
    expect(
      await dispatchGoogleSheetsLead(
        sampleRecord,
        { GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/demo/exec' },
        badFetch as unknown as typeof fetch,
      ),
    ).toBe(false);

    const throwFetch = vi.fn(async () => {
      throw new Error('timeout');
    });
    expect(
      await dispatchGoogleSheetsLead(
        sampleRecord,
        { GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/demo/exec' },
        throwFetch as unknown as typeof fetch,
      ),
    ).toBe(false);
  });

  it('sends Resend confirmation emails for residential, B2B, and gift leads with error handling', async () => {
    const quote = calculateQuote({
      mode: 'flat_rate',
      service: 'move_out',
      bedrooms: 2,
      bathrooms: 2,
    });
    const baseLead: LeadSubmissionPayload = {
      leadType: 'residential_quote',
      name: 'Jordan & "Sam"',
      phone: '(780) 710-1503',
      email: 'jordan@example.ca',
      postalCode: 'T6W',
      caslSmsConsent: true,
      quoteInput: { mode: 'flat_rate', service: 'move_out', bedrooms: 2, bathrooms: 2 },
      preferredSlot: { date: '2026-12-02', window: 'morning' },
    };

    expect(await sendCustomerConfirmationEmail(baseLead, 'LU-E1', quote)).toBe(false);
    expect(
      await sendCustomerConfirmationEmail(
        { ...baseLead, email: undefined },
        'LU-E1',
        quote,
        { RESEND_API_KEY: 're_test_key' },
      ),
    ).toBe(false);

    const sentBodies: Array<Record<string, unknown>> = [];
    const okFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body)));
      return new Response('{"id":"email_1"}', { status: 200 });
    });

    expect(
      await sendCustomerConfirmationEmail(
        baseLead,
        'LU-E1',
        quote,
        { RESEND_API_KEY: 're_test_key', RESEND_FROM_EMAIL: 'Custom <hi@levelupcleaning.ca>' },
        okFetch as unknown as typeof fetch,
      ),
    ).toBe(true);
    expect(String(sentBodies[0].html)).toContain('Morning (8:30 AM – 12:30 PM)');
    expect(String(sentBodies[0].html)).toContain('Jordan &amp; &quot;Sam&quot;');

    expect(
      await sendCustomerConfirmationEmail(
        { ...baseLead, preferredSlot: { date: '2026-12-03', window: 'afternoon' } },
        'LU-E2',
        quote,
        { RESEND_API_KEY: 're_test_key' },
        okFetch as unknown as typeof fetch,
      ),
    ).toBe(true);
    expect(String(sentBodies[1].html)).toContain('Afternoon (1:30 PM – 5:30 PM)');

    expect(
      await sendCustomerConfirmationEmail(
        { ...baseLead, preferredSlot: { date: '2026-12-04', window: 'full_day' } },
        'LU-E3',
        quote,
        { RESEND_API_KEY: 're_test_key' },
        okFetch as unknown as typeof fetch,
      ),
    ).toBe(true);
    expect(String(sentBodies[2].html)).toContain('Full Day (8:30 AM – 4:30 PM)');

    expect(
      await sendCustomerConfirmationEmail(
        { ...baseLead, preferredSlot: undefined, preferredDate: undefined },
        'LU-E4',
        quote,
        { RESEND_API_KEY: 're_test_key' },
        okFetch as unknown as typeof fetch,
      ),
    ).toBe(true);
    expect(String(sentBodies[3].html)).toContain('Flexible — we will confirm via SMS');

    expect(
      await sendCustomerConfirmationEmail(
        {
          ...baseLead,
          leadType: 'b2b_partner',
          b2bDetails: {
            companyOrRole: 'realtor',
            propertiesCount: 5,
            preferredTurnoverWindow: '11am–3pm',
            monthlyFrequency: 'Weekly',
          },
        },
        'LU-B2B1',
        quote,
        { RESEND_API_KEY: 're_test_key' },
        okFetch as unknown as typeof fetch,
      ),
    ).toBe(true);
    expect(String(sentBodies[4].html)).toContain('Your LevelUp B2B Partner Inquiry Is In');

    expect(
      await sendCustomerConfirmationEmail(
        {
          ...baseLead,
          leadType: 'gift_certificate',
          giftDetails: {
            amountCad: 250,
            recipientName: 'Sarah',
            deliveryMethod: 'printable_pdf',
          },
        },
        'LU-GIFT1',
        quote,
        { RESEND_API_KEY: 're_test_key' },
        okFetch as unknown as typeof fetch,
      ),
    ).toBe(true);
    expect(String(sentBodies[5].html)).toContain('Your LevelUp Gift Certificate Request Is Received');

    const failFetch = vi.fn(async () => {
      throw new Error('Resend unreachable');
    });
    expect(
      await sendCustomerConfirmationEmail(
        baseLead,
        'LU-ERR',
        quote,
        { RESEND_API_KEY: 're_test_key' },
        failFetch as unknown as typeof fetch,
      ),
    ).toBe(false);
  });
});

describe('tracking.ts — Browser Meta Pixel & Google Ads tracking plus SSR safety guard', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it('no-ops cleanly in non-browser SSR environments', () => {
    delete (globalThis as Record<string, unknown>).window;
    expect(() =>
      initAdTracking({ metaPixelId: 'px_ssr', googleAdsId: 'AW-SSR' }),
    ).not.toThrow();
    expect(() =>
      trackClientViewContent({
        contentName: 'Move-Out',
        contentCategory: 'move_out',
        valueCad: 310,
        eventId: 'evt-ssr',
      }),
    ).not.toThrow();
    expect(() =>
      trackClientLeadConversion({
        leadId: 'LU-SSR',
        valueCad: 310,
        service: 'move_out',
      }),
    ).not.toThrow();
  });

  it('initializes pixels once and dispatches ViewContent and Lead conversions to fbq and gtag', () => {
    const fbq = vi.fn();
    const gtag = vi.fn();
    (globalThis as Record<string, unknown>).window = {
      fbq,
      gtag,
      __LEVELUP_TRACKING: { googleAdsLeadLabel: 'initial_label' },
    };

    initAdTracking({ metaPixelId: 'px_12345', googleAdsId: 'AW-98765' });
    initAdTracking({ metaPixelId: 'px_12345', googleAdsId: 'AW-98765' });

    expect(fbq).toHaveBeenCalledTimes(2);
    expect(fbq).toHaveBeenNthCalledWith(1, 'init', 'px_12345');
    expect(fbq).toHaveBeenNthCalledWith(2, 'track', 'PageView');
    expect(gtag).toHaveBeenCalledTimes(1);
    expect(gtag).toHaveBeenCalledWith('config', 'AW-98765');

    trackClientViewContent({
      contentName: 'Move-Out Cleaning',
      contentCategory: 'move_out',
      valueCad: 285.456,
      eventId: 'vc-1',
    });
    expect(fbq).toHaveBeenCalledWith(
      'track',
      'ViewContent',
      {
        content_name: 'Move-Out Cleaning',
        content_category: 'move_out',
        value: 285.46,
        currency: 'CAD',
      },
      { eventID: 'vc-1' },
    );
    expect(gtag).toHaveBeenCalledWith('event', 'view_item', {
      currency: 'CAD',
      value: 285.46,
      items: [{ item_name: 'Move-Out Cleaning', item_category: 'move_out' }],
    });

    trackClientLeadConversion({
      leadId: 'LU-TRK1',
      valueCad: 310,
      service: 'move_out',
    });
    expect(fbq).toHaveBeenCalledWith(
      'track',
      'Lead',
      {
        value: 310,
        currency: 'CAD',
        content_name: 'move_out',
        content_category: 'move_out',
      },
      { eventID: 'LU-TRK1' },
    );
    expect(gtag).toHaveBeenCalledWith('event', 'conversion', {
      send_to: 'AW-98765/initial_label',
      value: 310,
      currency: 'CAD',
      transaction_id: 'LU-TRK1',
    });

    (globalThis as Record<string, unknown>).window = {
      fbq,
      gtag,
      __LEVELUP_TRACKING: { googleAdsId: 'AW-ONLY' },
    };
    trackClientLeadConversion({
      leadId: 'LU-TRK2',
      valueCad: Number.NaN,
      service: 'deep_clean',
    });
    expect(gtag).toHaveBeenCalledWith('event', 'generate_lead', {
      value: 0,
      currency: 'CAD',
      transaction_id: 'LU-TRK2',
      service: 'deep_clean',
    });

    (globalThis as Record<string, unknown>).window = {};
    expect(() => initAdTracking()).not.toThrow();
    expect(() =>
      trackClientViewContent({
        contentName: 'Empty',
        contentCategory: 'regular',
        valueCad: Number.NaN,
        eventId: 'vc-2',
      }),
    ).not.toThrow();
    expect(() =>
      trackClientLeadConversion({
        leadId: 'LU-TRK3',
        valueCad: 120,
        service: 'regular',
      }),
    ).not.toThrow();
  });
});
