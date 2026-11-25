import { describe, expect, it, vi } from 'vitest';
import {
  buildCapiEventPayload,
  dispatchMetaCapiEvent,
  normalizePhoneDigits,
  sha256Hex,
} from '../src/lib/capi';
import {
  AUTHORIZED_TELEGRAM_ADMIN_IDS,
  escapeTelegramHtml,
  formatTelegramLeadMessage,
  processLeadSubmission,
  validateLeadPayload,
} from '../src/lib/lead-pipeline';
import { lookupPostalCode } from '../src/lib/postal';
import { calculateQuote } from '../src/lib/pricing';

describe('capi.ts — Meta Conversions API hashing, normalization, and dispatch', () => {
  it('computes SHA-256 hex digests and normalizes North American phone numbers', async () => {
    const digest = await sha256Hex('ca');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(null as unknown as string)).toBe(await sha256Hex(''));

    expect(normalizePhoneDigits('(780) 710-1503')).toBe('17807101503');
    expect(normalizePhoneDigits('+1 780-710-1503')).toBe('17807101503');
    expect(normalizePhoneDigits('001-780-710-1503')).toBe('17807101503');
    expect(normalizePhoneDigits('007807101503')).toBe('17807101503');
    expect(normalizePhoneDigits('7101503')).toBe('7101503');
    expect(normalizePhoneDigits('---')).toBe('');
    expect(normalizePhoneDigits(null as unknown as string)).toBe('');
  });

  it('builds Lead, Purchase, and ViewContent CAPI payloads with hashed PII and fbp/fbc', async () => {
    const leadPayload = await buildCapiEventPayload({
      eventName: 'Lead',
      eventId: 'evt-123',
      eventTime: 1764000000.9,
      eventSourceUrl: 'https://levelupcleaning.ca/lp/move-out',
      value: 310.456,
      contentName: 'Move-Out Quote',
      contentCategory: 'move_out',
      phone: '(780) 710-1503',
      email: '  Client@Example.CA ',
      postalCode: 'T6W 1A2',
      fbp: 'fb.1.111.222',
      fbclid: 'IwAR_test_click',
      clientIpAddress: '203.0.113.10',
      clientUserAgent: 'Mozilla/5.0 Test',
      externalId: 'LU-999',
      testEventCode: 'TEST1234',
    });

    expect(leadPayload.test_event_code).toBe('TEST1234');
    const item = leadPayload.data[0];
    expect(item.event_name).toBe('Lead');
    expect(item.event_time).toBe(1764000000);
    expect(item.event_id).toBe('evt-123');
    expect(item.action_source).toBe('website');
    expect(item.event_source_url).toBe('https://levelupcleaning.ca/lp/move-out');
    expect(item.custom_data).toEqual({
      currency: 'CAD',
      value: 310.46,
      content_name: 'Move-Out Quote',
      content_category: 'move_out',
    });
    expect(item.user_data.ph).toEqual([await sha256Hex('17807101503')]);
    expect(item.user_data.em).toEqual([await sha256Hex('client@example.ca')]);
    expect(item.user_data.zp).toEqual([await sha256Hex('t6w')]);
    expect(item.user_data.external_id).toEqual([await sha256Hex('lu-999')]);
    expect(item.user_data.fbp).toBe('fb.1.111.222');
    expect(item.user_data.fbc).toBe('fb.1.1764000000000.IwAR_test_click');
    expect(item.user_data.client_ip_address).toBe('203.0.113.10');
    expect(item.user_data.client_user_agent).toBe('Mozilla/5.0 Test');

    // Purchase defaults to system_generated; explicit fbc takes precedence; edge blank inputs skipped
    const purchasePayload = await buildCapiEventPayload({
      eventName: 'Purchase',
      value: -50,
      phone: '---',
      email: '   ',
      postalCode: ' - ',
      fbc: 'fb.1.999.explicit',
    });
    expect(purchasePayload.data[0].action_source).toBe('system_generated');
    expect(purchasePayload.data[0].custom_data.value).toBe(0);
    expect(purchasePayload.data[0].user_data.ph).toBeUndefined();
    expect(purchasePayload.data[0].user_data.em).toBeUndefined();
    expect(purchasePayload.data[0].user_data.zp).toBeUndefined();
    expect(purchasePayload.data[0].user_data.fbc).toBe('fb.1.999.explicit');
    expect(purchasePayload.data[0].event_id.length).toBeGreaterThan(8);
  });

  it('dispatches Meta CAPI events and handles missing credentials, HTTP errors, and network failures', async () => {
    const sample = await buildCapiEventPayload({ eventName: 'ViewContent', value: 210 });

    expect(await dispatchMetaCapiEvent(sample)).toEqual({
      dispatched: false,
      reason: 'missing_credentials',
    });
    expect(await dispatchMetaCapiEvent(sample, { META_PIXEL_ID: '123' })).toEqual({
      dispatched: false,
      reason: 'missing_credentials',
    });

    const okFetch = vi.fn(async () => new Response('{"events_received":1}', { status: 200 }));
    const okRes = await dispatchMetaCapiEvent(
      sample,
      { META_PIXEL_ID: 'px123', META_CAPI_TOKEN: 'tok456', META_TEST_EVENT_CODE: 'ENVTEST' },
      okFetch as unknown as typeof fetch,
    );
    expect(okRes).toEqual({ dispatched: true, status: 200 });
    expect(okFetch).toHaveBeenCalledTimes(1);
    const [, reqInit] = okFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(reqInit.body)).test_event_code).toBe('ENVTEST');

    const badHttpFetch = vi.fn(async () => new Response('Bad Request', { status: 400 }));
    const httpErr = await dispatchMetaCapiEvent(
      { ...sample, test_event_code: 'KEEP_ME' },
      { META_PIXEL_ID: 'px123', META_CAPI_TOKEN: 'tok456', META_TEST_EVENT_CODE: 'ENVTEST' },
      badHttpFetch as unknown as typeof fetch,
    );
    expect(httpErr).toEqual({ dispatched: false, status: 400, reason: 'http_error' });

    const throwingFetch = vi.fn(async () => {
      throw new Error('DNS failure');
    });
    const netErr = await dispatchMetaCapiEvent(
      sample,
      { META_PIXEL_ID: 'px123', META_CAPI_TOKEN: 'tok456' },
      throwingFetch as unknown as typeof fetch,
    );
    expect(netErr).toEqual({ dispatched: false, reason: 'network_error' });
  });
});

describe('lead-pipeline.ts — Validation, HTML escaping, Telegram & CAPI orchestration', () => {
  const validBase = {
    name: 'Olena Kovalenko',
    phone: '(780) 710-1503',
    email: 'olena@example.ca',
    postalCode: 't6w 1a2',
    preferredDate: '2026-12-05',
    hasPets: true,
    notes: 'Lockbox #1234 & <Calacatta> "quartz"',
    caslSmsConsent: true,
    honeypot: '',
    quoteInput: {
      mode: 'flat_rate',
      service: 'move_out',
      bedrooms: 2,
      bathrooms: 2,
      frequency: 'one_time',
      addons: ['inside_oven', 'interior_windows', 'inside_oven', 'unknown_addon'],
      promoQuery: '50',
    },
    attribution: {
      fbclid: 'fb_click_1',
      utmSource: 'instagram',
      utmMedium: 'paid_social',
      utmCampaign: 'yeg_moveout_nov2026',
      landingPath: '/lp/move-out',
      eventId: 'dedup-evt-1',
    },
  };

  it('escapes HTML entities safely for Telegram parse_mode=HTML', () => {
    expect(escapeTelegramHtml(`<script>alert("x" & 'y')</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;',
    );
    expect(escapeTelegramHtml(null as unknown as string)).toBe('');
  });

  it('rejects every invalid lead payload branch with clear errors', () => {
    expect(validateLeadPayload(null).valid).toBe(false);
    expect(validateLeadPayload([]).valid).toBe(false);
    expect(validateLeadPayload('str').valid).toBe(false);

    expect(validateLeadPayload({ ...validBase, honeypot: 'https://spam.example' })).toEqual({
      valid: false,
      error: 'Automated submission rejected.',
    });

    expect(validateLeadPayload({ ...validBase, name: '   ' })).toEqual({
      valid: false,
      error: 'Full name is required.',
    });

    expect(validateLeadPayload({ ...validBase, phone: 7807101503 })).toEqual({
      valid: false,
      error: 'Phone number is required.',
    });
    expect(validateLeadPayload({ ...validBase, phone: '780-1234' })).toEqual({
      valid: false,
      error: 'Phone number must contain 10 to 15 digits.',
    });
    expect(validateLeadPayload({ ...validBase, phone: '12345678901234567' })).toEqual({
      valid: false,
      error: 'Phone number must contain 10 to 15 digits.',
    });

    expect(validateLeadPayload({ ...validBase, email: 12345 })).toEqual({
      valid: false,
      error: 'Invalid email address.',
    });
    expect(validateLeadPayload({ ...validBase, email: 'not-an-email' })).toEqual({
      valid: false,
      error: 'Please provide a valid email address.',
    });

    expect(validateLeadPayload({ ...validBase, postalCode: '' })).toEqual({
      valid: false,
      error: 'Edmonton or Capital Region postal code is required.',
    });
    expect(validateLeadPayload({ ...validBase, postalCode: 'T2P 1J9' }).valid).toBe(false);

    expect(validateLeadPayload({ ...validBase, caslSmsConsent: false })).toEqual({
      valid: false,
      error: 'Explicit CASL SMS consent is required before submitting your quote request.',
    });

    expect(validateLeadPayload({ ...validBase, quoteInput: null })).toEqual({
      valid: false,
      error: 'Quote configuration is required.',
    });
    expect(
      validateLeadPayload({ ...validBase, quoteInput: { mode: 'magic', service: 'move_out' } }),
    ).toEqual({
      valid: false,
      error: 'Quote mode must be flat_rate or hourly.',
    });
    expect(
      validateLeadPayload({ ...validBase, quoteInput: { mode: 'flat_rate', service: 'duct_clean' } }),
    ).toEqual({
      valid: false,
      error: 'Unsupported cleaning service selected.',
    });
    expect(
      validateLeadPayload({
        ...validBase,
        quoteInput: { mode: 'flat_rate', service: 'regular', addons: 'inside_oven' },
      }),
    ).toEqual({
      valid: false,
      error: 'Add-ons list must be an array.',
    });

    // Snap & Lock photo validations
    expect(validateLeadPayload({ ...validBase, snapPhotos: 'bad' })).toEqual({
      valid: false,
      error: 'Snap & Lock photos must be provided as an array.',
    });
    const validPhoto = { filename: 'kitchen.jpg', mimeType: 'image/jpeg', base64Data: 'QUJDRA==' };
    expect(
      validateLeadPayload({ ...validBase, snapPhotos: [validPhoto, validPhoto, validPhoto] }),
    ).toEqual({
      valid: false,
      error: 'Maximum 2 Snap & Lock photos are allowed.',
    });
    expect(validateLeadPayload({ ...validBase, snapPhotos: [null] })).toEqual({
      valid: false,
      error: 'Invalid photo attachment object.',
    });
    expect(
      validateLeadPayload({
        ...validBase,
        snapPhotos: [{ ...validPhoto, mimeType: 'image/svg+xml' }],
      }),
    ).toEqual({
      valid: false,
      error: 'Snap & Lock photos must be image/jpeg, image/png, or image/webp.',
    });
    expect(
      validateLeadPayload({ ...validBase, snapPhotos: [{ ...validPhoto, base64Data: '   ' }] }),
    ).toEqual({
      valid: false,
      error: 'Each Snap & Lock photo must be non-empty and at most 2,500,000 characters.',
    });
    expect(
      validateLeadPayload({
        ...validBase,
        snapPhotos: [{ ...validPhoto, base64Data: 'A'.repeat(2_500_001) }],
      }),
    ).toEqual({
      valid: false,
      error: 'Each Snap & Lock photo must be non-empty and at most 2,500,000 characters.',
    });
  });

  it('formats Telegram HTML messages for both flat-rate and hourly quotes', () => {
    const validated = validateLeadPayload({
      ...validBase,
      snapPhotos: [{ filename: '', mimeType: 'image/webp', base64Data: 'QUJDRA==' }],
    });
    expect(validated.valid).toBe(true);
    if (!validated.valid) return;
    expect(validated.data.snapPhotos?.[0].filename).toBe('snap-photo-1.jpg');

    const postal = lookupPostalCode(validated.data.postalCode);
    const quote = calculateQuote({
      ...validated.data.quoteInput,
      service: 'regular',
      frequency: 'weekly',
    });
    const html = formatTelegramLeadMessage('LU-TEST01', validated.data, quote, postal);
    expect(html).toContain('#LU-TEST01');
    expect(html).toContain('&lt;Calacatta&gt; &quot;quartz&quot;');
    expect(html).toContain('Recurring Savings (15%)');
    expect(html).toContain('Snap &amp; Lock Photos:');
    expect(html).toContain('path=/lp/move-out | src=instagram | cmp=yeg_moveout_nov2026');

    // Minimal hourly message
    const minValidated = validateLeadPayload({
      name: 'Sam',
      phone: '7807101503',
      postalCode: 'T5K',
      caslSmsConsent: true,
      quoteInput: { mode: 'hourly', service: 'hourly', hours: 4, cleaners: 2 },
      attribution: {},
    });
    expect(minValidated.valid).toBe(true);
    if (!minValidated.valid) return;
    const hourlyQuote = calculateQuote(minValidated.data.quoteInput);
    const hourlyHtml = formatTelegramLeadMessage(
      'LU-HRLY',
      minValidated.data,
      hourlyQuote,
      lookupPostalCode('T5K'),
    );
    expect(hourlyHtml).toContain('8 cleaner-hours @ $48/hr');
    expect(hourlyHtml).toContain('Add-Ons:</b> None');
  });

  it('processes lead submission in demo mode, live dual-admin Telegram + CAPI mode, and partial failure recovery', async () => {
    // Validation failure in processLeadSubmission
    const invalidRes = await processLeadSubmission({ name: '' }, { TELEGRAM_BOT_TOKEN: 'bot-tok' });
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.mode).toBe('live');

    // Clean demo mode (no secrets)
    const demoFetch = vi.fn();
    const demoRes = await processLeadSubmission(validBase, undefined, {
      fetchImpl: demoFetch as unknown as typeof fetch,
    });
    expect(demoRes.ok).toBe(true);
    expect(demoRes.mode).toBe('demo');
    expect(demoRes.telegramDispatched).toBe(false);
    expect(demoRes.capiDispatched).toBe(false);
    expect(demoRes.finalPreTaxCad).toBe(335); // Move-out 2bd ($310) + 2nd bath ($25) + windows ($50) - $50 promo = $335
    expect(demoFetch).not.toHaveBeenCalled();

    // Live mode: dispatches sendMessage + sendPhoto to BOTH 633982504 & 332623386 + Meta CAPI Lead
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const liveFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('{"ok":true}', { status: 200 });
    });

    const liveRes = await processLeadSubmission(
      {
        ...validBase,
        attribution: { landingPath: 'lp/move-out' }, // without leading slash
        snapPhotos: [
          {
            filename: 'oven.jpg',
            mimeType: 'image/jpeg',
            base64Data: 'data:image/jpeg;base64,SGVsbG8td29ybGQ_',
          },
        ],
      },
      {
        TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
        META_PIXEL_ID: 'px999',
        META_CAPI_TOKEN: 'capi_tok',
      },
      {
        clientIpAddress: '198.51.100.5',
        clientUserAgent: 'PlaywrightTest/1.0',
        fetchImpl: liveFetch as unknown as typeof fetch,
      },
    );

    expect(liveRes.ok).toBe(true);
    expect(liveRes.mode).toBe('live');
    expect(liveRes.telegramDispatched).toBe(true);
    expect(liveRes.capiDispatched).toBe(true);

    const msgCalls = calls.filter((c) => c.url.endsWith('/sendMessage'));
    const photoCalls = calls.filter((c) => c.url.endsWith('/sendPhoto'));
    const capiCalls = calls.filter((c) => c.url.includes('graph.facebook.com'));

    expect(msgCalls).toHaveLength(2);
    expect(photoCalls).toHaveLength(2);
    expect(capiCalls).toHaveLength(1);

    const sentAdminIds = msgCalls.map((c) => JSON.parse(String(c.init?.body)).chat_id);
    expect(sentAdminIds).toEqual([...AUTHORIZED_TELEGRAM_ADMIN_IDS]);

    // Partial failure recovery: 1st admin throws, 2nd admin succeeds, sendPhoto throws
    let msgAttempt = 0;
    const flakyFetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/sendMessage')) {
        msgAttempt += 1;
        if (msgAttempt === 1) throw new Error('Timeout on first admin');
        return new Response('{"ok":true}', { status: 200 });
      }
      if (u.endsWith('/sendPhoto')) {
        throw new Error('Photo upload network blip');
      }
      return new Response('{"events_received":1}', { status: 200 });
    });

    const recovered = await processLeadSubmission(
      {
        ...validBase,
        attribution: undefined,
        snapPhotos: [{ filename: 'bath.png', mimeType: 'image/png', base64Data: 'QUJD' }],
      },
      { TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN' },
      { fetchImpl: flakyFetch as unknown as typeof fetch },
    );
    expect(recovered.ok).toBe(true);
    expect(recovered.telegramDispatched).toBe(true);
  });
});
