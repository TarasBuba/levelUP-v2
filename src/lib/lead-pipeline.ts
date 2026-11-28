import type {
  AddonId,
  AttributionData,
  B2BPartnerDetails,
  Frequency,
  GiftCertificateDetails,
  LeadSubmissionPayload,
  LeadSubmissionResult,
  LeadType,
  PostalLookupResult,
  PreferredSlotSelection,
  QuoteBreakdown,
  QuoteInput,
  ServiceId,
  SlotWindow,
  SnapPhotoAttachment,
} from '../types/contracts';
import { buildSignedAdminUrl } from './admin-signing';
import {
  AFTERNOON_TIME_RANGE,
  type CalendarStoreEnv,
  MORNING_TIME_RANGE,
  reserveCalendarSlot,
} from './calendar-store';
import {
  buildCapiEventPayload,
  type CapiEnv,
  dispatchMetaCapiEvent,
} from './capi';
import {
  dispatchGoogleSheetsLead,
  type LeadLedgerEnv,
  type LeadLedgerRecord,
  saveLeadRecord,
  sendCustomerConfirmationEmail,
} from './lead-ledger';
import { lookupPostalCode } from './postal';
import { buildSmsPrefillHref, calculateQuote } from './pricing';

export const AUTHORIZED_TELEGRAM_ADMIN_IDS = ['633982504', '332623386'] as const;

const ALLOWED_PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_SNAP_PHOTOS = 2;
const MAX_SNAP_PHOTO_BASE64_CHARS = 2_500_000;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const VALID_LEAD_TYPES: readonly LeadType[] = [
  'residential_quote',
  'b2b_partner',
  'gift_certificate',
];

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

const VALID_SLOT_WINDOWS: readonly SlotWindow[] = ['morning', 'afternoon', 'full_day'];

const VALID_B2B_ROLES: readonly B2BPartnerDetails['companyOrRole'][] = [
  'realtor',
  'property_manager',
  'airbnb_host',
  'developer',
];

const VALID_GIFT_DELIVERY: readonly GiftCertificateDetails['deliveryMethod'][] = [
  'email',
  'sms',
  'printable_pdf',
];

export interface LeadPipelineEnv extends CapiEnv, CalendarStoreEnv, LeadLedgerEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ADMIN_ACTION_SECRET?: string;
  ADMIN_DASHBOARD_SECRET?: string;
}

export interface LeadRequestMeta {
  clientIpAddress?: string;
  clientUserAgent?: string;
  eventSourceUrl?: string;
  fetchImpl?: typeof fetch;
}

interface TelegramInlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

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

function clampBedroomBathroom(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1;
  }
  return Math.min(5, Math.max(1, Math.round(value)));
}

function formatSlotWindowLabel(windowChoice: SlotWindow): string {
  if (windowChoice === 'morning') {
    return `Morning (${MORNING_TIME_RANGE})`;
  }
  if (windowChoice === 'afternoon') {
    return `Afternoon (${AFTERNOON_TIME_RANGE})`;
  }
  return 'Full Day (8:30 AM – 4:30 PM)';
}

function formatB2bRoleLabel(role: B2BPartnerDetails['companyOrRole']): string {
  if (role === 'realtor') {
    return 'Realtor / Listing Agent';
  }
  if (role === 'property_manager') {
    return 'Property Manager';
  }
  if (role === 'airbnb_host') {
    return 'Airbnb / Short-Term Rental Host';
  }
  return 'Builder / Developer';
}

function sanitizeAttribution(raw: unknown): AttributionData | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  return {
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
}

function parseQuoteInput(
  rawQuote: unknown,
  postalCode: string,
): { valid: true; quoteInput: QuoteInput } | { valid: false; error: string } {
  if (!isPlainObject(rawQuote)) {
    return { valid: false, error: 'Quote configuration is required.' };
  }

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

  return {
    valid: true,
    quoteInput: {
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
    },
  };
}

export function validateLeadPayload(
  body: unknown,
): { valid: true; data: LeadSubmissionPayload } | { valid: false; error: string } {
  if (!isPlainObject(body)) {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  if (body.honeypot !== undefined && body.honeypot !== null && String(body.honeypot).trim() !== '') {
    return { valid: false, error: 'Automated submission rejected.' };
  }

  let leadType: LeadType = 'residential_quote';
  if (body.leadType !== undefined && body.leadType !== null) {
    if (
      typeof body.leadType !== 'string' ||
      !(VALID_LEAD_TYPES as readonly string[]).includes(body.leadType)
    ) {
      return { valid: false, error: 'Unsupported lead type.' };
    }
    leadType = body.leadType as LeadType;
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

  let postalCode = 'T5J';
  if (leadType === 'residential_quote') {
    if (typeof body.postalCode !== 'string' || body.postalCode.trim().length === 0) {
      return { valid: false, error: 'Edmonton or Capital Region postal code is required.' };
    }
    const postalCheck = lookupPostalCode(body.postalCode);
    if (!postalCheck.valid) {
      return { valid: false, error: postalCheck.message };
    }
    postalCode = body.postalCode.trim().toUpperCase();
  } else if (typeof body.postalCode === 'string' && body.postalCode.trim().length > 0) {
    const postalCheck = lookupPostalCode(body.postalCode);
    if (!postalCheck.valid) {
      return { valid: false, error: postalCheck.message };
    }
    postalCode = body.postalCode.trim().toUpperCase();
  }

  if (body.caslSmsConsent !== true) {
    return {
      valid: false,
      error: 'Explicit CASL SMS consent is required before submitting your quote request.',
    };
  }

  let b2bDetails: B2BPartnerDetails | undefined;
  if (leadType === 'b2b_partner') {
    if (!isPlainObject(body.b2bDetails)) {
      return { valid: false, error: 'B2B partner details are required.' };
    }
    const role = body.b2bDetails.companyOrRole;
    if (typeof role !== 'string' || !(VALID_B2B_ROLES as readonly string[]).includes(role)) {
      return { valid: false, error: 'Please select a valid B2B partner role.' };
    }
    const rawCount = Number(body.b2bDetails.propertiesCount);
    if (!Number.isFinite(rawCount) || rawCount < 1) {
      return { valid: false, error: 'Please provide at least 1 managed property or unit.' };
    }
    b2bDetails = {
      companyOrRole: role as B2BPartnerDetails['companyOrRole'],
      propertiesCount: Math.min(500, Math.max(1, Math.round(rawCount))),
      preferredTurnoverWindow:
        optionalTrimmedString(body.b2bDetails.preferredTurnoverWindow, 80) ?? '11:00 AM – 3:00 PM',
      monthlyFrequency:
        optionalTrimmedString(body.b2bDetails.monthlyFrequency, 80) ?? 'Weekly / As Needed',
    };
  }

  let giftDetails: GiftCertificateDetails | undefined;
  if (leadType === 'gift_certificate') {
    if (!isPlainObject(body.giftDetails)) {
      return { valid: false, error: 'Gift certificate details are required.' };
    }
    const rawAmount = Number(body.giftDetails.amountCad);
    if (!Number.isFinite(rawAmount) || rawAmount < 50 || rawAmount > 5000) {
      return { valid: false, error: 'Gift certificate amount must be between $50 and $5,000 CAD.' };
    }
    const recipientName = optionalTrimmedString(body.giftDetails.recipientName, 120);
    if (!recipientName) {
      return { valid: false, error: 'Gift recipient name is required.' };
    }
    const rawDelivery = body.giftDetails.deliveryMethod;
    const deliveryMethod: GiftCertificateDetails['deliveryMethod'] =
      typeof rawDelivery === 'string' &&
      (VALID_GIFT_DELIVERY as readonly string[]).includes(rawDelivery)
        ? (rawDelivery as GiftCertificateDetails['deliveryMethod'])
        : 'email';
    const personalMessage = optionalTrimmedString(body.giftDetails.personalMessage, 400);
    giftDetails = {
      amountCad: Math.round(rawAmount),
      recipientName,
      ...(personalMessage ? { personalMessage } : {}),
      deliveryMethod,
    };
  }

  let quoteInput: QuoteInput;
  if (leadType === 'residential_quote' || body.quoteInput !== undefined) {
    const parsedQuote = parseQuoteInput(body.quoteInput, postalCode);
    if (!parsedQuote.valid) {
      return parsedQuote;
    }
    quoteInput = parsedQuote.quoteInput;
  } else if (leadType === 'b2b_partner') {
    quoteInput = {
      mode: 'flat_rate',
      service: 'airbnb',
      bedrooms: 2,
      bathrooms: 1,
      frequency: 'weekly',
      addons: [],
      postalCode,
      promoQuery: null,
    };
  } else {
    quoteInput = {
      mode: 'flat_rate',
      service: 'regular',
      bedrooms: 2,
      bathrooms: 1,
      frequency: 'one_time',
      addons: [],
      postalCode,
      promoQuery: null,
    };
  }

  let preferredSlot: PreferredSlotSelection | undefined;
  if (body.preferredSlot !== undefined && body.preferredSlot !== null) {
    if (!isPlainObject(body.preferredSlot)) {
      return { valid: false, error: 'Preferred slot must be a valid date and time window.' };
    }
    const slotDate =
      typeof body.preferredSlot.date === 'string' ? body.preferredSlot.date.trim() : '';
    const slotWindow = body.preferredSlot.window;
    if (
      !DATE_KEY_PATTERN.test(slotDate) ||
      typeof slotWindow !== 'string' ||
      !(VALID_SLOT_WINDOWS as readonly string[]).includes(slotWindow)
    ) {
      return {
        valid: false,
        error: 'Preferred slot must specify a valid YYYY-MM-DD date and time window.',
      };
    }
    preferredSlot = {
      date: slotDate,
      window: slotWindow as SlotWindow,
    };
  }

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

  const preferredDate = optionalTrimmedString(body.preferredDate, 80) ?? preferredSlot?.date;
  const notes = optionalTrimmedString(body.notes, 1000);
  const attribution = sanitizeAttribution(body.attribution);

  const payload: LeadSubmissionPayload = {
    leadType,
    name,
    phone,
    ...(email ? { email } : {}),
    postalCode,
    ...(preferredDate ? { preferredDate } : {}),
    ...(preferredSlot ? { preferredSlot } : {}),
    ...(typeof body.hasPets === 'boolean' ? { hasPets: body.hasPets } : {}),
    ...(notes ? { notes } : {}),
    caslSmsConsent: true,
    honeypot: '',
    quoteInput,
    ...(b2bDetails ? { b2bDetails } : {}),
    ...(giftDetails ? { giftDetails } : {}),
    ...(snapPhotos && snapPhotos.length > 0 ? { snapPhotos } : {}),
    ...(attribution ? { attribution } : {}),
  };

  return { valid: true, data: payload };
}

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

  if (data.leadType === 'b2b_partner' && data.b2bDetails) {
    const lines: string[] = [
      `🏢 <b>VIP B2B PARTNER LEAD</b> <code>#${safeLeadId}</code>`,
      '',
      `👤 <b>Contact:</b> ${safeName}`,
      `📱 <b>Phone (CASL OK):</b> ${safePhone}`,
    ];
    if (data.email) {
      lines.push(`✉️ <b>Email:</b> ${escapeTelegramHtml(data.email)}`);
    }
    lines.push(`📍 <b>Primary Zone:</b> ${safeArea} (<code>${safePostal}</code>)`);
    lines.push('');
    lines.push(`💼 <b>Partner Role:</b> ${escapeTelegramHtml(formatB2bRoleLabel(data.b2bDetails.companyOrRole))}`);
    lines.push(`🏘 <b>Properties / Units:</b> ${data.b2bDetails.propertiesCount}`);
    lines.push(`⏰ <b>Turnover Window:</b> ${escapeTelegramHtml(data.b2bDetails.preferredTurnoverWindow)}`);
    lines.push(`🔁 <b>Cadence:</b> ${escapeTelegramHtml(data.b2bDetails.monthlyFrequency)}`);
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

  if (data.leadType === 'gift_certificate' && data.giftDetails) {
    const lines: string[] = [
      `🎁 <b>GIFT CERTIFICATE ORDER</b> <code>#${safeLeadId}</code>`,
      '',
      `👤 <b>Buyer:</b> ${safeName}`,
      `📱 <b>Phone (CASL OK):</b> ${safePhone}`,
    ];
    if (data.email) {
      lines.push(`✉️ <b>Email:</b> ${escapeTelegramHtml(data.email)}`);
    }
    lines.push('');
    lines.push(`💵 <b>Gift Value:</b> <b>$${Math.round(data.giftDetails.amountCad)} CAD</b>`);
    lines.push(`🎀 <b>Recipient:</b> ${escapeTelegramHtml(data.giftDetails.recipientName)}`);
    lines.push(`📬 <b>Delivery:</b> ${escapeTelegramHtml(data.giftDetails.deliveryMethod)}`);
    if (data.giftDetails.personalMessage) {
      lines.push(`💌 <b>Card Message:</b> ${escapeTelegramHtml(data.giftDetails.personalMessage)}`);
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

  const safeService = escapeTelegramHtml(quote.serviceTitle);
  const clampedBeds = clampBedroomBathroom(data.quoteInput.bedrooms);
  const clampedBaths = clampBedroomBathroom(data.quoteInput.bathrooms);

  const scopeLine =
    quote.mode === 'hourly'
      ? `${quote.basePriceCad / 48} cleaner-hours @ $48/hr`
      : `${clampedBeds} Bed / ${clampedBaths} Bath (${escapeTelegramHtml(data.quoteInput.frequency ?? 'one_time')})`;

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

  if (data.preferredSlot) {
    lines.push(
      `🗓 <b>Preferred Slot:</b> ${escapeTelegramHtml(data.preferredSlot.date)} — ${escapeTelegramHtml(formatSlotWindowLabel(data.preferredSlot.window))}`,
    );
  } else if (data.preferredDate) {
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

function resolveHttpsOrigin(eventSourceUrl?: string): string {
  if (eventSourceUrl) {
    try {
      const parsed = new URL(eventSourceUrl);
      if (parsed.protocol === 'https:') {
        return parsed.origin;
      }
    } catch {
      return 'https://levelupcleaning.ca';
    }
  }
  return 'https://levelupcleaning.ca';
}

async function buildTelegramInlineKeyboard(
  leadId: string,
  data: LeadSubmissionPayload,
  quote: QuoteBreakdown,
  signingSecret: string,
  origin: string,
): Promise<TelegramInlineButton[][]> {
  if (signingSecret) {
    const rows: TelegramInlineButton[][] = [];

    if (data.preferredSlot) {
      const [confirmUrl, releaseUrl] = await Promise.all([
        buildSignedAdminUrl(
          origin,
          {
            action: 'confirm_slot',
            leadId,
            date: data.preferredSlot.date,
            window: data.preferredSlot.window,
            name: data.name,
            phone: data.phone,
          },
          signingSecret,
        ),
        buildSignedAdminUrl(
          origin,
          {
            action: 'release_slot',
            leadId,
            date: data.preferredSlot.date,
            window: data.preferredSlot.window,
            name: data.name,
          },
          signingSecret,
        ),
      ]);
      rows.push([
        { text: '✅ Confirm & Lock Slot', url: confirmUrl },
        { text: '🔓 Release Slot', url: releaseUrl },
      ]);
    }

    const [confirmPriceUrl, markPaidUrl] = await Promise.all([
      buildSignedAdminUrl(
        origin,
        {
          action: 'confirm_price',
          leadId,
          amountCad: quote.finalPreTaxCad,
          service: quote.service,
          name: data.name,
          phone: data.phone,
        },
        signingSecret,
      ),
      buildSignedAdminUrl(
        origin,
        {
          action: 'mark_paid',
          leadId,
          amountCad: quote.finalPreTaxCad,
          service: quote.service,
          name: data.name,
        },
        signingSecret,
      ),
    ]);

    rows.push([
      { text: '📸 Price Confirmed → SMS', url: confirmPriceUrl },
      { text: `💰 Paid $${quote.finalPreTaxCad} CAD`, url: markPaidUrl },
    ]);

    return rows;
  }

  const callbackData = `paid:${leadId}:${quote.finalPreTaxCad}:${quote.service}`;
  return [
    [
      {
        text: `💰 Paid $${quote.finalPreTaxCad} CAD`,
        callback_data: callbackData,
      },
    ],
  ];
}

async function dispatchTelegramAlerts(
  leadId: string,
  data: LeadSubmissionPayload,
  quote: QuoteBreakdown,
  postal: PostalLookupResult,
  botToken: string,
  signingSecret: string,
  origin: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const htmlMessage = formatTelegramLeadMessage(leadId, data, quote, postal);
  const inlineKeyboard = await buildTelegramInlineKeyboard(
    leadId,
    data,
    quote,
    signingSecret,
    origin,
  );
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
            inline_keyboard: inlineKeyboard,
          },
        }),
      });

      if (msgRes.ok) {
        anyMessageSent = true;
      }
    } catch {
      continue;
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
          continue;
        }
      }
    }
  }

  return anyMessageSent;
}

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
  const calculatedQuote = calculateQuote({
    ...data.quoteInput,
    postalCode: data.postalCode,
  });

  const quote: QuoteBreakdown =
    data.leadType === 'gift_certificate' && data.giftDetails
      ? {
          ...calculatedQuote,
          serviceTitle: 'Gift Certificate',
          finalPreTaxCad: Math.round(data.giftDetails.amountCad),
          estimatedGstCad: 0,
        }
      : calculatedQuote;

  const leadId = generateCompactLeadId();
  const smsPrefillHref = buildSmsPrefillHref(quote, postal.normalizedFsa, data.name);
  const fetcher = meta?.fetchImpl ?? globalThis.fetch;

  let slotReserved = false;
  if (data.preferredSlot) {
    const reservation = await reserveCalendarSlot(data.preferredSlot, leadId, env, {
      fetchImpl: fetcher,
    });
    if (!reservation.ok) {
      return {
        ok: false,
        leadId: '',
        finalPreTaxCad: quote.finalPreTaxCad,
        areaName: postal.areaName,
        smsPrefillHref,
        telegramDispatched: false,
        capiDispatched: false,
        slotReserved: false,
        mode,
        error: 'That time window was just booked. Please pick another open slot.',
      };
    }
    slotReserved = true;
  }

  const eventSourceUrl =
    meta?.eventSourceUrl?.trim() ||
    (data.attribution?.landingPath
      ? `https://levelupcleaning.ca${data.attribution.landingPath.startsWith('/') ? '' : '/'}${data.attribution.landingPath}`
      : 'https://levelupcleaning.ca/');

  const signingSecret =
    env?.TELEGRAM_WEBHOOK_SECRET?.trim() || env?.ADMIN_ACTION_SECRET?.trim() || '';
  const origin = resolveHttpsOrigin(eventSourceUrl);

  const ledgerRecord: LeadLedgerRecord = {
    leadId,
    createdAt: new Date().toISOString(),
    leadType: data.leadType ?? 'residential_quote',
    name: data.name,
    phone: data.phone,
    ...(data.email ? { email: data.email } : {}),
    postalCode: data.postalCode,
    areaName: postal.areaName,
    service: quote.service,
    serviceTitle: quote.serviceTitle,
    finalPreTaxCad: quote.finalPreTaxCad,
    estimatedGstCad: quote.estimatedGstCad,
    ...(data.preferredDate ? { preferredDate: data.preferredDate } : {}),
    ...(data.preferredSlot ? { preferredSlot: data.preferredSlot } : {}),
    ...(typeof data.hasPets === 'boolean' ? { hasPets: data.hasPets } : {}),
    ...(data.notes ? { notes: data.notes } : {}),
    ...(data.b2bDetails ? { b2bDetails: data.b2bDetails } : {}),
    ...(data.giftDetails ? { giftDetails: data.giftDetails } : {}),
    ...(data.attribution?.utmSource ? { utmSource: data.attribution.utmSource } : {}),
    ...(data.attribution?.utmMedium ? { utmMedium: data.attribution.utmMedium } : {}),
    ...(data.attribution?.utmCampaign ? { utmCampaign: data.attribution.utmCampaign } : {}),
    ...(data.attribution?.landingPath ? { landingPath: data.attribution.landingPath } : {}),
    snapPhotosCount: data.snapPhotos?.length ?? 0,
  };

  let telegramDispatched = false;
  if (hasTelegramSecret && env?.TELEGRAM_BOT_TOKEN) {
    telegramDispatched = await dispatchTelegramAlerts(
      leadId,
      data,
      quote,
      postal,
      env.TELEGRAM_BOT_TOKEN.trim(),
      signingSecret,
      origin,
      fetcher,
    );
  }

  const [ledgerSaved, sheetsDispatched, confirmationEmailSent] = await Promise.all([
    saveLeadRecord(ledgerRecord, env, fetcher),
    dispatchGoogleSheetsLead(ledgerRecord, env, fetcher),
    sendCustomerConfirmationEmail(data, leadId, quote, env, fetcher),
  ]);

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
    slotReserved,
    ledgerSaved,
    sheetsDispatched,
    confirmationEmailSent,
    mode,
  };
}
