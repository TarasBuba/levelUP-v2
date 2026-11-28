import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCapiEventPayload,
  dispatchMetaCapiEvent,
  normalizePhoneDigits,
  sha256Hex,
} from '../src/lib/capi';
import {
  getCalendarSchedule,
  resetMemoryCalendarStore,
  setSlotStateAdmin,
} from '../src/lib/calendar-store';
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

describe('lead-pipeline.ts — Validation, HTML escaping, B2B/Gift cards, Slots, Signed Buttons & CAPI', () => {
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

  beforeEach(() => {
    resetMemoryCalendarStore();
  });

  it('escapes HTML entities safely for Telegram parse_mode=HTML', () => {
    expect(escapeTelegramHtml(`<script>alert("x" & 'y')</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;',
    );
    expect(escapeTelegramHtml(null as unknown as string)).toBe('');
  });

  it('rejects every invalid residential, B2B, gift, slot, and photo payload branch', () => {
    expect(validateLeadPayload(null).valid).toBe(false);
    expect(validateLeadPayload([]).valid).toBe(false);
    expect(validateLeadPayload('str').valid).toBe(false);

    expect(validateLeadPayload({ ...validBase, honeypot: 'https://spam.example' })).toEqual({
      valid: false,
      error: 'Automated submission rejected.',
    });

    expect(validateLeadPayload({ ...validBase, leadType: 'invalid_type' })).toEqual({
      valid: false,
      error: 'Unsupported lead type.',
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

    expect(
      validateLeadPayload({
        leadType: 'b2b_partner',
        name: 'Alex',
        phone: '7807101503',
        postalCode: 'T2P 1J9',
        caslSmsConsent: true,
        b2bDetails: { companyOrRole: 'realtor', propertiesCount: 2 },
      }).valid,
    ).toBe(false);

    expect(validateLeadPayload({ ...validBase, caslSmsConsent: false })).toEqual({
      valid: false,
      error: 'Explicit CASL SMS consent is required before submitting your quote request.',
    });

    expect(
      validateLeadPayload({
        leadType: 'b2b_partner',
        name: 'Alex',
        phone: '7807101503',
        caslSmsConsent: true,
      }),
    ).toEqual({
      valid: false,
      error: 'B2B partner details are required.',
    });
    expect(
      validateLeadPayload({
        leadType: 'b2b_partner',
        name: 'Alex',
        phone: '7807101503',
        caslSmsConsent: true,
        b2bDetails: { companyOrRole: 'broker', propertiesCount: 2 },
      }),
    ).toEqual({
      valid: false,
      error: 'Please select a valid B2B partner role.',
    });
    expect(
      validateLeadPayload({
        leadType: 'b2b_partner',
        name: 'Alex',
        phone: '7807101503',
        caslSmsConsent: true,
        b2bDetails: { companyOrRole: 'realtor', propertiesCount: 0 },
      }),
    ).toEqual({
      valid: false,
      error: 'Please provide at least 1 managed property or unit.',
    });

    expect(
      validateLeadPayload({
        leadType: 'gift_certificate',
        name: 'Buyer',
        phone: '7807101503',
        caslSmsConsent: true,
      }),
    ).toEqual({
      valid: false,
      error: 'Gift certificate details are required.',
    });
    expect(
      validateLeadPayload({
        leadType: 'gift_certificate',
        name: 'Buyer',
        phone: '7807101503',
        caslSmsConsent: true,
        giftDetails: { amountCad: 25, recipientName: 'Sarah' },
      }),
    ).toEqual({
      valid: false,
      error: 'Gift certificate amount must be between $50 and $5,000 CAD.',
    });
    expect(
      validateLeadPayload({
        leadType: 'gift_certificate',
        name: 'Buyer',
        phone: '7807101503',
        caslSmsConsent: true,
        giftDetails: { amountCad: 250, recipientName: '   ' },
      }),
    ).toEqual({
      valid: false,
      error: 'Gift recipient name is required.',
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

    expect(validateLeadPayload({ ...validBase, preferredSlot: 'tomorrow' })).toEqual({
      valid: false,
      error: 'Preferred slot must be a valid date and time window.',
    });
    expect(
      validateLeadPayload({
        ...validBase,
        preferredSlot: { date: 'bad-date', window: 'morning' },
      }),
    ).toEqual({
      valid: false,
      error: 'Preferred slot must specify a valid YYYY-MM-DD date and time window.',
    });
    expect(
      validateLeadPayload({
        ...validBase,
        preferredSlot: { date: '2026-12-05', window: 'night' },
      }),
    ).toEqual({
      valid: false,
      error: 'Preferred slot must specify a valid YYYY-MM-DD date and time window.',
    });

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

  it('formats Telegram HTML cards for residential (with slots), hourly, B2B partner roles, and gift orders', () => {
    const validated = validateLeadPayload({
      ...validBase,
      preferredSlot: { date: '2026-12-05', window: 'morning' },
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
    expect(html).toContain('Preferred Slot:</b> 2026-12-05 — Morning');
    expect(html).toContain('Recurring Savings (15%)');
    expect(html).toContain('Snap &amp; Lock Photos:');
    expect(html).toContain('path=/lp/move-out | src=instagram | cmp=yeg_moveout_nov2026');

    const afternoonHtml = formatTelegramLeadMessage(
      'LU-AFT',
      { ...validated.data, preferredSlot: { date: '2026-12-06', window: 'afternoon' } },
      quote,
      postal,
    );
    expect(afternoonHtml).toContain('Afternoon (1:30 PM – 5:30 PM)');

    const fullDayHtml = formatTelegramLeadMessage(
      'LU-FULL',
      { ...validated.data, preferredSlot: { date: '2026-12-07', window: 'full_day' } },
      quote,
      postal,
    );
    expect(fullDayHtml).toContain('Full Day (8:30 AM – 4:30 PM)');

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

    for (const [role, expectedLabel] of [
      ['realtor', 'Realtor / Listing Agent'],
      ['property_manager', 'Property Manager'],
      ['airbnb_host', 'Airbnb / Short-Term Rental Host'],
      ['developer', 'Builder / Developer'],
    ] as const) {
      const b2bValid = validateLeadPayload({
        leadType: 'b2b_partner',
        name: 'Alex Chen',
        phone: '7807101503',
        email: 'alex@brokerage.ca',
        postalCode: 'T5J',
        notes: '3 downtown suites',
        caslSmsConsent: true,
        b2bDetails: {
          companyOrRole: role,
          propertiesCount: 4,
          preferredTurnoverWindow: '11am–3pm',
          monthlyFrequency: 'Weekly',
        },
        attribution: {
          landingPath: '/airbnb-cleaning-edmonton',
          utmSource: 'linkedin',
          utmCampaign: 'yeg_b2b',
        },
      });
      expect(b2bValid.valid).toBe(true);
      if (!b2bValid.valid) return;
      const b2bMsg = formatTelegramLeadMessage(
        'LU-B2B',
        b2bValid.data,
        calculateQuote(b2bValid.data.quoteInput),
        lookupPostalCode('T5J'),
      );
      expect(b2bMsg).toContain('VIP B2B PARTNER LEAD');
      expect(b2bMsg).toContain(expectedLabel);
      expect(b2bMsg).toContain('alex@brokerage.ca');
      expect(b2bMsg).toContain('3 downtown suites');
      expect(b2bMsg).toContain('src=linkedin');
    }

    const giftValid = validateLeadPayload({
      leadType: 'gift_certificate',
      name: 'Taylor',
      phone: '7807101503',
      email: 'taylor@example.ca',
      notes: 'Deliver by Friday',
      caslSmsConsent: true,
      giftDetails: {
        amountCad: 350,
        recipientName: 'Sarah & Mark',
        personalMessage: 'Happy Holidays!',
        deliveryMethod: 'invalid_falls_back_to_email',
      },
      attribution: {
        landingPath: '/gift-a-clean',
        utmSource: 'google',
        utmCampaign: 'holiday_gift',
      },
    });
    expect(giftValid.valid).toBe(true);
    if (!giftValid.valid) return;
    expect(giftValid.data.giftDetails?.deliveryMethod).toBe('email');
    const giftMsg = formatTelegramLeadMessage(
      'LU-GIFT',
      giftValid.data,
      calculateQuote(giftValid.data.quoteInput),
      lookupPostalCode('T5J'),
    );
    expect(giftMsg).toContain('GIFT CERTIFICATE ORDER');
    expect(giftMsg).toContain('$350 CAD');
    expect(giftMsg).toContain('Sarah &amp; Mark');
    expect(giftMsg).toContain('Happy Holidays!');
    expect(giftMsg).toContain('Deliver by Friday');
    expect(giftMsg).toContain('src=google');
  });

  it('processes lead submissions with slot reservation, conflict rejection, HMAC-signed URL buttons, ledger, sheets, email & CAPI', async () => {
    const invalidRes = await processLeadSubmission({ name: '' }, { TELEGRAM_BOT_TOKEN: 'bot-tok' });
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.mode).toBe('live');

    const demoFetch = vi.fn();
    const demoRes = await processLeadSubmission(validBase, undefined, {
      fetchImpl: demoFetch as unknown as typeof fetch,
    });
    expect(demoRes.ok).toBe(true);
    expect(demoRes.mode).toBe('demo');
    expect(demoRes.telegramDispatched).toBe(false);
    expect(demoRes.capiDispatched).toBe(false);
    expect(demoRes.finalPreTaxCad).toBe(335);
    expect(demoFetch).not.toHaveBeenCalled();

    const giftRes = await processLeadSubmission(
      {
        leadType: 'gift_certificate',
        name: 'Morgan',
        phone: '7807101503',
        caslSmsConsent: true,
        giftDetails: {
          amountCad: 250,
          recipientName: 'Chris',
          deliveryMethod: 'printable_pdf',
        },
      },
      undefined,
      { fetchImpl: demoFetch as unknown as typeof fetch },
    );
    expect(giftRes.ok).toBe(true);
    expect(giftRes.finalPreTaxCad).toBe(250);

    const openDate = (await getCalendarSchedule()).days[3].date;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const liveFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('{"ok":true}', { status: 200 });
    });

    const signedRes = await processLeadSubmission(
      {
        ...validBase,
        preferredSlot: { date: openDate, window: 'morning' },
        attribution: { landingPath: 'lp/move-out' },
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
        TELEGRAM_WEBHOOK_SECRET: 'whsec_test_signing_key',
        META_PIXEL_ID: 'px999',
        META_CAPI_TOKEN: 'capi_tok',
        GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/demo/exec',
        RESEND_API_KEY: 're_test_key',
        LEVELUP_KV: {
          get: vi.fn(async () => null),
          put: vi.fn(async () => {}),
        },
      },
      {
        clientIpAddress: '198.51.100.5',
        clientUserAgent: 'PlaywrightTest/1.0',
        eventSourceUrl: 'https://levelupcleaning.ca/lp/move-out',
        fetchImpl: liveFetch as unknown as typeof fetch,
      },
    );

    expect(signedRes.ok).toBe(true);
    expect(signedRes.mode).toBe('live');
    expect(signedRes.slotReserved).toBe(true);
    expect(signedRes.ledgerSaved).toBe(true);
    expect(signedRes.sheetsDispatched).toBe(true);
    expect(signedRes.confirmationEmailSent).toBe(true);
    expect(signedRes.telegramDispatched).toBe(true);
    expect(signedRes.capiDispatched).toBe(true);

    const msgCalls = calls.filter((c) => c.url.endsWith('/sendMessage'));
    const photoCalls = calls.filter((c) => c.url.endsWith('/sendPhoto'));
    const capiCalls = calls.filter((c) => c.url.includes('graph.facebook.com'));
    expect(msgCalls).toHaveLength(2);
    expect(photoCalls).toHaveLength(2);
    expect(capiCalls).toHaveLength(1);

    const sentAdminIds = msgCalls.map((c) => JSON.parse(String(c.init?.body)).chat_id);
    expect(sentAdminIds).toEqual([...AUTHORIZED_TELEGRAM_ADMIN_IDS]);

    const keyboard = JSON.parse(String(msgCalls[0].init?.body)).reply_markup.inline_keyboard;
    expect(keyboard).toHaveLength(2);
    expect(keyboard[0][0].url).toContain('https://levelupcleaning.ca/api/admin-action?token=');
    expect(keyboard[0][1].url).toContain('https://levelupcleaning.ca/api/admin-action?token=');
    expect(keyboard[1][0].url).toContain('https://levelupcleaning.ca/api/admin-action?token=');
    expect(keyboard[1][1].url).toContain('https://levelupcleaning.ca/api/admin-action?token=');

    await setSlotStateAdmin(openDate, 'morning', 'booked', 'LU-LOCKED');
    const conflictRes = await processLeadSubmission(
      {
        ...validBase,
        preferredSlot: { date: openDate, window: 'morning' },
      },
      undefined,
      { fetchImpl: liveFetch as unknown as typeof fetch },
    );
    expect(conflictRes.ok).toBe(false);
    expect(conflictRes.slotReserved).toBe(false);
    expect(conflictRes.error).toContain('just booked');

    let msgAttempt = 0;
    const fallbackCalls: Array<{ url: string; init?: RequestInit }> = [];
    const flakyFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      fallbackCalls.push({ url: u, init });
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
      {
        eventSourceUrl: 'http://localhost:4321/',
        fetchImpl: flakyFetch as unknown as typeof fetch,
      },
    );
    expect(recovered.ok).toBe(true);
    expect(recovered.telegramDispatched).toBe(true);
    const cbKeyboard = JSON.parse(String(fallbackCalls[1].init?.body)).reply_markup.inline_keyboard;
    expect(cbKeyboard[0][0].callback_data).toMatch(/^paid:LU-/);

    const badOriginFetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const badOriginRes = await processLeadSubmission(
      { ...validBase, attribution: undefined },
      { TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN', ADMIN_ACTION_SECRET: 'alt_admin_sec' },
      { eventSourceUrl: 'not-a-valid-url', fetchImpl: badOriginFetch as unknown as typeof fetch },
    );
    expect(badOriginRes.ok).toBe(true);
  });
});
