import type {
  AddonId,
  AttributionData,
  Frequency,
  LeadSubmissionPayload,
  LeadSubmissionResult,
  PostalLookupResult,
  QuoteBreakdown,
  QuoteInput,
  ServiceId,
  SnapPhotoAttachment,
} from '../types/contracts';
import {
  buildCapiEventPayload,
  type CapiEnv,
  dispatchMetaCapiEvent,
} from './capi';
import { lookupPostalCode } from './postal';
import { buildSmsPrefillHref, calculateQuote } from './pricing';

export const AUTHORIZED_TELEGRAM_ADMIN_IDS = ['633982504', '332623386'] as const;

const ALLOWED_PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_SNAP_PHOTOS = 2;
const MAX_SNAP_PHOTO_BASE64_CHARS = 2_500_000;

const VALID_SERVICES: readonly ServiceId[] = [
  'move_out',
  'deep_clean',
  'regular',
  'airbnb',
  'hourly',
];

const VALID_FREQUENCIES: readonly Frequency[] = ['one_time', 'weekly', 'biweekly', 'monthly'];

const VALID_ADDONS: readonly AddonId[] = [
  'inside_oven',
  'inside_fridge',
  'inside_cabinets',
  'interior_windows',
  'wall_spot_wash',
  'heavy_pet_hair',
  'basement_suite',
];

export interface LeadPipelineEnv extends CapiEnv {
  TELEGRAM_BOT_TOKEN?: string;
}

export interface LeadRequestMeta {
  clientIpAddress?: string;
  clientUserAgent?: string;
  eventSourceUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Escapes untrusted strings for safe inclusion in Telegram Bot API `HTML` messages.
 */
export function escapeTelegramHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function optionalTrimmedString(val: unknown, maxLen: number): string | undefined {
  if (typeof val !== 'string') {
    return undefined;
  }
  const trimmed = val.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, maxLen);
}

function sanitizeAttribution(raw: unknown): AttributionData | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const attribution: AttributionData = {
    fbclid: optionalTrimmedString(raw.fbclid, 256),
    fbp: optionalTrimmedString(raw.fbp, 256),
    fbc: optionalTrimmedString(raw.fbc, 512),
    gclid: optionalTrimmedString(raw.gclid, 256),
    utmSource: optionalTrimmedString(raw.utmSource, 128),
    utmMedium: optionalTrimmedString(raw.utmMedium, 128),
    utmCampaign: optionalTrimmedString(raw.utmCampaign, 160),
    landingPath: optionalTrimmedString(raw.landingPath, 256),
    eventId: optionalTrimmedString(raw.eventId, 128),
  };
  return attribution;
}

/**
 * Strictly validates an untrusted JSON request body before lead processing.
 */
export function validateLeadPayload(
  body: unknown,
): { valid: true; data: LeadSubmissionPayload } | { valid: false; error: string } {
  if (!isPlainObject(body)) {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  if (body.honeypot !== undefined && body.honeypot !== null && String(body.honeypot).trim() !== '') {
    return { valid: false, error: 'Automated submission rejected.' };
  }

  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    return { valid: false, error: 'Full name is required.' };
  }
  const name = body.name.trim().slice(0, 120);

  if (typeof body.phone !== 'string') {
    return { valid: false, error: 'Phone number is required.' };
  }
  const phoneDigits = body.phone.replace(/\D+/g, '');
  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    return { valid: false, error: 'Phone number must contain 10 to 15 digits.' };
  }
  const phone = body.phone.trim().slice(0, 40);

  let email: string | undefined;
  if (body.email !== undefined && body.email !== null && String(body.email).trim() !== '') {
    if (typeof body.email !== 'string') {
      return { valid: false, error: 'Invalid email address.' };
    }
    const trimmedEmail = body.email.trim();
    if (trimmedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      return { valid: false, error: 'Please provide a valid email address.' };
    }
    email = trimmedEmail;
  }

  if (typeof body.postalCode !== 'string' || body.postalCode.trim().length === 0) {
    return { valid: false, error: 'Edmonton or Capital Region postal code is required.' };
  }
  const postalCheck = lookupPostalCode(body.postalCode);
  if (!postalCheck.valid) {
    return { valid: false, error: postalCheck.message };
  }
  const postalCode = body.postalCode.trim().toUpperCase();

  if (body.caslSmsConsent !== true) {
    return {
      valid: false,
      error: 'Explicit CASL SMS consent is required before submitting your quote request.',
    };
  }

  if (!isPlainObject(body.quoteInput)) {
    return { valid: false, error: 'Quote configuration is required.' };
  }

  const rawQuote = body.quoteInput;
  if (rawQuote.mode !== 'flat_rate' && rawQuote.mode !== 'hourly') {
    return { valid: false, error: 'Quote mode must be flat_rate or hourly.' };
  }
  if (
    typeof rawQuote.service !== 'string' ||
    !(VALID_SERVICES as readonly string[]).includes(rawQuote.service)
  ) {
    return { valid: false, error: 'Unsupported cleaning service selected.' };
  }

  const addons: AddonId[] = [];
  if (rawQuote.addons !== undefined) {
    if (!Array.isArray(rawQuote.addons)) {
      return { valid: false, error: 'Add-ons list must be an array.' };
    }
    for (const addon of rawQuote.addons) {
      if (typeof addon === 'string' && (VALID_ADDONS as readonly string[]).includes(addon)) {
        const typedAddon = addon as AddonId;
        if (!addons.includes(typedAddon)) {
          addons.push(typedAddon);
        }
      }
    }
  }

  const frequency: Frequency | undefined =
    typeof rawQuote.frequency === 'string' &&
    (VALID_FREQUENCIES as readonly string[]).includes(rawQuote.frequency)
      ? (rawQuote.frequency as Frequency)
      : undefined;

  const quoteInput: QuoteInput = {
    mode: rawQuote.mode,
    service: rawQuote.service as ServiceId,
    bedrooms: typeof rawQuote.bedrooms === 'number' ? rawQuote.bedrooms : undefined,
    bathrooms: typeof rawQuote.bathrooms === 'number' ? rawQuote.bathrooms : undefined,
    frequency,
    addons,
    hours: typeof rawQuote.hours === 'number' ? rawQuote.hours : undefined,
    cleaners: typeof rawQuote.cleaners === 'number' ? rawQuote.cleaners : undefined,
    postalCode,
    promoQuery:
      typeof rawQuote.promoQuery === 'string'
        ? rawQuote.promoQuery.trim().slice(0, 64)
        : null,
  };

  let snapPhotos: SnapPhotoAttachment[] | undefined;
  if (body.snapPhotos !== undefined && body.snapPhotos !== null) {
    if (!Array.isArray(body.snapPhotos)) {
      return { valid: false, error: 'Snap & Lock photos must be provided as an array.' };
    }
    if (body.snapPhotos.length > MAX_SNAP_PHOTOS) {
      return { valid: false, error: `Maximum ${MAX_SNAP_PHOTOS} Snap & Lock photos are allowed.` };
    }
    snapPhotos = [];
    for (const item of body.snapPhotos) {
      if (!isPlainObject(item)) {
        return { valid: false, error: 'Invalid photo attachment object.' };
      }
      if (typeof item.mimeType !== 'string' || !ALLOWED_PHOTO_MIMES.has(item.mimeType)) {
        return {
          valid: false,
          error: 'Snap & Lock photos must be image/jpeg, image/png, or image/webp.',
        };
      }
      if (
        typeof item.base64Data !== 'string' ||
        item.base64Data.trim().length === 0 ||
        item.base64Data.length > MAX_SNAP_PHOTO_BASE64_CHARS
      ) {
        return {
          valid: false,
          error: 'Each Snap & Lock photo must be non-empty and at most 2,500,000 characters.',
        };
      }
      const filename =
        typeof item.filename === 'string' && item.filename.trim().length > 0
          ? item.filename.trim().slice(0, 160)
          : `snap-photo-${snapPhotos.length + 1}.jpg`;
      snapPhotos.push({
        filename,
        mimeType: item.mimeType,
        base64Data: item.base64Data,
      });
    }
  }

  const payload: LeadSubmissionPayload = {
    name,
    phone,
    ...(email ? { email } : {}),
    postalCode,
    ...(optionalTrimmedString(body.preferredDate, 80)
      ? { preferredDate: optionalTrimmedString(body.preferredDate, 80) }
      : {}),
    ...(typeof body.hasPets === 'boolean' ? { hasPets: body.hasPets } : {}),
    ...(optionalTrimmedString(body.notes, 1000)
      ? { notes: optionalTrimmedString(body.notes, 1000) }
      : {}),
    caslSmsConsent: true,
    honeypot: '',
    quoteInput,
    ...(snapPhotos && snapPhotos.length > 0 ? { snapPhotos } : {}),
    ...(sanitizeAttribution(body.attribution)
      ? { attribution: sanitizeAttribution(body.attribution) }
      : {}),
  };

  return { valid: true, data: payload };
}

/**
 * Formats an HTML-escaped Telegram dispatch summary for Edmonton operations admins.
 */
export function formatTelegramLeadMessage(
  leadId: string,
  data: LeadSubmissionPayload,
  quote: QuoteBreakdown,
  postal: PostalLookupResult,
): string {
  const safeLeadId = escapeTelegramHtml(leadId);
  const safeName = escapeTelegramHtml(data.name);
  const safePhone = escapeTelegramHtml(data.phone);
  const safePostal = escapeTelegramHtml(data.postalCode);
  const safeArea = escapeTelegramHtml(`${postal.normalizedFsa} — ${postal.areaName}`);
  const safeService = escapeTelegramHtml(quote.serviceTitle);

  const scopeLine =
    quote.mode === 'hourly'
      ? `${quote.basePriceCad / 48} cleaner-hours @ $48/hr`
      : `${data.quoteInput.bedrooms ?? 1} Bed / ${data.quoteInput.bathrooms ?? 1} Bath (${escapeTelegramHtml(data.quoteInput.frequency ?? 'one_time')})`;

  const addonsSummary =
    quote.addonsDetail.length > 0
      ? quote.addonsDetail
          .map((item) =>
            item.includedFree
              ? `${escapeTelegramHtml(item.label)} (FREE)`
              : `${escapeTelegramHtml(item.label)} (+$${item.chargedPriceCad})`,
          )
          .join(', ')
      : 'None';

  const lines: string[] = [
    `🌿 <b>New LevelUp Cleaning Lead</b> <code>#${safeLeadId}</code>`,
    '',
    `👤 <b>Client:</b> ${safeName}`,
    `📱 <b>Phone (CASL OK):</b> ${safePhone}`,
  ];

  if (data.email) {
    lines.push(`✉️ <b>Email:</b> ${escapeTelegramHtml(data.email)}`);
  }

  lines.push(`📍 <b>Zone:</b> ${safeArea} (<code>${safePostal}</code>)`);

  if (data.preferredDate) {
    lines.push(`🗓 <b>Preferred Date:</b> ${escapeTelegramHtml(data.preferredDate)}`);
  }

  lines.push(`🐾 <b>Pets at Home:</b> ${data.hasPets ? 'Yes' : 'No'}`);
  lines.push('');
  lines.push(`🧼 <b>Service:</b> ${safeService}`);
  lines.push(`📐 <b>Scope:</b> ${scopeLine}`);
  lines.push(`➕ <b>Add-Ons:</b> ${addonsSummary}`);
  lines.push(`🚗 <b>Travel Fee:</b> $${quote.travelFeeCad} CAD`);

  if (quote.frequencyDiscountCad > 0) {
    lines.push(
      `🔁 <b>Recurring Savings (${quote.frequencyDiscountPct}%):</b> -$${quote.frequencyDiscountCad} CAD`,
    );
  }

  if (quote.promo.discountCad > 0) {
    lines.push(
      `🏷 <b>Promo (${escapeTelegramHtml(quote.promo.appliedCode)}):</b> -$${quote.promo.discountCad} CAD`,
    );
  }

  lines.push(
    `💰 <b>Locked Pre-Tax Quote:</b> <b>$${quote.finalPreTaxCad} CAD</b> (+ 5% AB GST where applicable / est. $${quote.estimatedGstCad.toFixed(2)})`,
  );

  if (data.snapPhotos && data.snapPhotos.length > 0) {
    lines.push(`📸 <b>Snap &amp; Lock Photos:</b> ${data.snapPhotos.length} attached below`);
  }

  if (data.notes) {
    lines.push(`📝 <b>Notes:</b> ${escapeTelegramHtml(data.notes)}`);
  }

  if (data.attribution) {
    const attrParts = [
      data.attribution.landingPath ? `path=${data.attribution.landingPath}` : '',
      data.attribution.utmSource ? `src=${data.attribution.utmSource}` : '',
      data.attribution.utmCampaign ? `cmp=${data.attribution.utmCampaign}` : '',
    ].filter(Boolean);
    if (attrParts.length > 0) {
      lines.push(`📊 <b>Source:</b> <code>${escapeTelegramHtml(attrParts.join(' | '))}</code>`);
    }
  }

  return lines.join('\n');
}

function decodeBase64ToBytes(rawBase64: string): Uint8Array {
  const cleaned = rawBase64
    .trim()
    .replace(/^data:image\/(?:jpeg|png|webp);base64,/i, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const padded = cleaned.padEnd(Math.ceil(cleaned.length / 4) * 4, '=');
  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function generateCompactLeadId(): string {
  const uuidHex = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  return `LU-${uuidHex}`;
}

async function dispatchTelegramAlerts(
  leadId: string,
  data: LeadSubmissionPayload,
  quote: QuoteBreakdown,
  postal: PostalLookupResult,
  botToken: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const htmlMessage = formatTelegramLeadMessage(leadId, data, quote, postal);
  const callbackData = `paid:${leadId}:${quote.finalPreTaxCad}:${quote.service}`;
  const sendMessageUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const sendPhotoUrl = `https://api.telegram.org/bot${botToken}/sendPhoto`;

  let anyMessageSent = false;

  for (const chatId of AUTHORIZED_TELEGRAM_ADMIN_IDS) {
    try {
      const msgRes = await fetchImpl(sendMessageUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: htmlMessage,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: `💰 Paid $${quote.finalPreTaxCad} CAD`,
                  callback_data: callbackData,
                },
              ],
            ],
          },
        }),
      });

      if (msgRes.ok) {
        anyMessageSent = true;
      }
    } catch {
      // Continue attempting remaining admins without failing lead capture
    }

    if (data.snapPhotos && data.snapPhotos.length > 0) {
      for (let i = 0; i < data.snapPhotos.length; i += 1) {
        const photo = data.snapPhotos[i];
        try {
          const bytes = decodeBase64ToBytes(photo.base64Data);
          const arrayBuffer = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
          const blob = new Blob([arrayBuffer], { type: photo.mimeType });
          const formData = new FormData();
          formData.append('chat_id', chatId);
          formData.append(
            'caption',
            `📸 Snap & Lock (${i + 1}/${data.snapPhotos.length}) — #${leadId} (${data.name})`.slice(
              0,
              1024,
            ),
          );
          formData.append('photo', blob, photo.filename);

          await fetchImpl(sendPhotoUrl, {
            method: 'POST',
            body: formData,
          });
        } catch {
          // Non-fatal photo attachment failure
        }
      }
    }
  }

  return anyMessageSent;
}

/**
 * Validates lead input, recomputes pricing server-side (never trusting client prices),
 * dispatches Telegram inline-action lead cards + Snap & Lock photos to authorized admins,
 * and sends a deduplicated Meta CAPI `Lead` event. Gracefully operates in `demo` mode
 * when cloud secrets are absent.
 */
export async function processLeadSubmission(
  body: unknown,
  env?: LeadPipelineEnv,
  meta?: LeadRequestMeta,
): Promise<LeadSubmissionResult> {
  const hasTelegramSecret = Boolean(env?.TELEGRAM_BOT_TOKEN?.trim());
  const hasCapiSecrets = Boolean(env?.META_PIXEL_ID?.trim() && env?.META_CAPI_TOKEN?.trim());
  const mode: 'live' | 'demo' = hasTelegramSecret || hasCapiSecrets ? 'live' : 'demo';

  const validation = validateLeadPayload(body);
  if (!validation.valid) {
    return {
      ok: false,
      leadId: '',
      finalPreTaxCad: 0,
      areaName: '',
      smsPrefillHref: 'sms:+17807101503',
      telegramDispatched: false,
      capiDispatched: false,
      mode,
      error: validation.error,
    };
  }

  const data = validation.data;
  const postal = lookupPostalCode(data.postalCode);
  const quote = calculateQuote({
    ...data.quoteInput,
    postalCode: data.postalCode,
  });

  const leadId = generateCompactLeadId();
  const smsPrefillHref = buildSmsPrefillHref(quote, postal.normalizedFsa, data.name);
  const fetcher = meta?.fetchImpl ?? globalThis.fetch;

  let telegramDispatched = false;
  if (hasTelegramSecret && env?.TELEGRAM_BOT_TOKEN) {
    telegramDispatched = await dispatchTelegramAlerts(
      leadId,
      data,
      quote,
      postal,
      env.TELEGRAM_BOT_TOKEN.trim(),
      fetcher,
    );
  }

  const eventSourceUrl =
    meta?.eventSourceUrl?.trim() ||
    (data.attribution?.landingPath
      ? `https://levelupcleaning.ca${data.attribution.landingPath.startsWith('/') ? '' : '/'}${data.attribution.landingPath}`
      : 'https://levelupcleaning.ca/');

  const capiPayload = await buildCapiEventPayload({
    eventName: 'Lead',
    eventId: data.attribution?.eventId || leadId,
    actionSource: 'website',
    eventSourceUrl,
    value: quote.finalPreTaxCad,
    currency: 'CAD',
    contentName: `${quote.serviceTitle} Quote Lead`,
    contentCategory: quote.service,
    phone: data.phone,
    email: data.email,
    postalCode: postal.normalizedFsa,
    fbp: data.attribution?.fbp,
    fbc: data.attribution?.fbc,
    fbclid: data.attribution?.fbclid,
    clientIpAddress: meta?.clientIpAddress,
    clientUserAgent: meta?.clientUserAgent,
    externalId: leadId,
  });

  const capiResult = await dispatchMetaCapiEvent(capiPayload, env, fetcher);

  return {
    ok: true,
    leadId,
    finalPreTaxCad: quote.finalPreTaxCad,
    areaName: postal.areaName,
    smsPrefillHref,
    telegramDispatched,
    capiDispatched: capiResult.dispatched,
    mode,
  };
}
