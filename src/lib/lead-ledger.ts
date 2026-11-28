import type {
  B2BPartnerDetails,
  GiftCertificateDetails,
  LeadSubmissionPayload,
  LeadType,
  PreferredSlotSelection,
  QuoteBreakdown,
  ServiceId,
} from '../types/contracts';
import type { KvNamespaceLike } from './slots';

const BLOB_API_BASE = 'https://blob.vercel-storage.com';
const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM_EMAIL = 'LevelUp Cleaning Edmonton <hello@levelupcleaning.ca>';

export interface LeadLedgerEnv {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  BLOB_READ_WRITE_TOKEN?: string;
  LEVELUP_KV?: KvNamespaceLike;
  GOOGLE_SHEETS_WEBHOOK_URL?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
}

export interface LeadLedgerRecord {
  leadId: string;
  createdAt: string;
  leadType: LeadType;
  name: string;
  phone: string;
  email?: string;
  postalCode: string;
  areaName: string;
  service: ServiceId;
  serviceTitle: string;
  finalPreTaxCad: number;
  estimatedGstCad: number;
  preferredDate?: string;
  preferredSlot?: PreferredSlotSelection;
  hasPets?: boolean;
  notes?: string;
  b2bDetails?: B2BPartnerDetails;
  giftDetails?: GiftCertificateDetails;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  landingPath?: string;
  snapPhotosCount: number;
}

function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function saveLeadRecord(
  record: LeadLedgerRecord,
  env?: LeadLedgerEnv,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const fetcher = fetchImpl ?? globalThis.fetch;
  const serialized = JSON.stringify(record);

  if (env?.UPSTASH_REDIS_REST_URL?.trim() && env?.UPSTASH_REDIS_REST_TOKEN?.trim()) {
    const baseUrl = env.UPSTASH_REDIS_REST_URL.trim().replace(/\/+$/, '');
    const token = env.UPSTASH_REDIS_REST_TOKEN.trim();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    try {
      const [setRes, listRes] = await Promise.all([
        fetcher(`${baseUrl}/set/levelup_lead:${encodeURIComponent(record.leadId)}`, {
          method: 'POST',
          headers,
          body: serialized,
        }),
        fetcher(`${baseUrl}/rpush/levelup_leads_v1`, {
          method: 'POST',
          headers,
          body: serialized,
        }),
      ]);
      return setRes.ok || listRes.ok;
    } catch {
      return false;
    }
  }

  if (env?.BLOB_READ_WRITE_TOKEN?.trim()) {
    const token = env.BLOB_READ_WRITE_TOKEN.trim();
    try {
      const response = await fetcher(
        `${BLOB_API_BASE}/levelup/leads/${encodeURIComponent(record.leadId)}.json`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-add-random-suffix': 'false',
            'x-content-type': 'application/json',
            'cache-control-max-age': '0',
          },
          body: serialized,
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  if (env?.LEVELUP_KV) {
    try {
      await env.LEVELUP_KV.put(`lead:${record.leadId}`, serialized);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

export async function dispatchGoogleSheetsLead(
  record: LeadLedgerRecord,
  env?: LeadLedgerEnv,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const webhookUrl = env?.GOOGLE_SHEETS_WEBHOOK_URL?.trim() ?? '';
  if (!webhookUrl) {
    return false;
  }
  const fetcher = fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetcher(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(record),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function formatSlotLine(slot?: PreferredSlotSelection, preferredDate?: string): string {
  if (slot) {
    const label =
      slot.window === 'morning'
        ? 'Morning (8:30 AM – 12:30 PM)'
        : slot.window === 'afternoon'
          ? 'Afternoon (1:30 PM – 5:30 PM)'
          : 'Full Day (8:30 AM – 4:30 PM)';
    return `${slot.date} — ${label}`;
  }
  return preferredDate || 'Flexible — we will confirm via SMS';
}

export async function sendCustomerConfirmationEmail(
  data: LeadSubmissionPayload,
  leadId: string,
  quote: QuoteBreakdown,
  env?: LeadLedgerEnv,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const apiKey = env?.RESEND_API_KEY?.trim() ?? '';
  const recipient = data.email?.trim() ?? '';
  if (!apiKey || !recipient) {
    return false;
  }

  const fetcher = fetchImpl ?? globalThis.fetch;
  const fromEmail = env?.RESEND_FROM_EMAIL?.trim() || DEFAULT_FROM_EMAIL;
  const safeName = escapeHtml(data.name);
  const safeLeadId = escapeHtml(leadId);
  const safeService = escapeHtml(quote.serviceTitle);
  const safeSlot = escapeHtml(formatSlotLine(data.preferredSlot, data.preferredDate));

  let heading = 'Your LevelUp Cleaning Estimate Is Reserved';
  let summaryBlock = `
    <p style="margin:0 0 10px;"><strong>Service:</strong> ${safeService}</p>
    <p style="margin:0 0 10px;"><strong>Estimated Pre-Tax Total:</strong> $${quote.finalPreTaxCad} CAD (+ 5% AB GST where applicable)</p>
    <p style="margin:0 0 10px;"><strong>Preferred Window:</strong> ${safeSlot}</p>
  `;

  if (data.leadType === 'b2b_partner' && data.b2bDetails) {
    heading = 'Your LevelUp B2B Partner Inquiry Is In';
    summaryBlock = `
      <p style="margin:0 0 10px;"><strong>Partner Role:</strong> ${escapeHtml(data.b2bDetails.companyOrRole)}</p>
      <p style="margin:0 0 10px;"><strong>Units / Properties:</strong> ${data.b2bDetails.propertiesCount}</p>
      <p style="margin:0 0 10px;"><strong>Turnover Window:</strong> ${escapeHtml(data.b2bDetails.preferredTurnoverWindow)}</p>
    `;
  } else if (data.leadType === 'gift_certificate' && data.giftDetails) {
    heading = 'Your LevelUp Gift Certificate Request Is Received';
    summaryBlock = `
      <p style="margin:0 0 10px;"><strong>Recipient:</strong> ${escapeHtml(data.giftDetails.recipientName)}</p>
      <p style="margin:0 0 10px;"><strong>Gift Value:</strong> $${Math.round(data.giftDetails.amountCad)} CAD</p>
      <p style="margin:0 0 10px;"><strong>Delivery Format:</strong> ${escapeHtml(data.giftDetails.deliveryMethod)}</p>
    `;
  }

  const html = `
    <div style="font-family:Inter,system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#172A22;background:#FAF8F4;border-radius:16px;border:1px solid #E2DDD5;">
      <p style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#2E6B57;margin:0 0 8px;">LevelUp Cleaning • Edmonton, AB</p>
      <h1 style="font-size:22px;line-height:1.25;margin:0 0 16px;color:#172A22;">${heading}</h1>
      <p style="margin:0 0 16px;">Hi ${safeName}, thank you for contacting LevelUp Cleaning. We have logged reference <strong>#${safeLeadId}</strong> and our local Edmonton coordinator will text you shortly to finalize your details.</p>
      <div style="background:#FFFFFF;padding:16px;border-radius:12px;border:1px solid #E2DDD5;margin:0 0 18px;">
        ${summaryBlock}
      </div>
      <p style="font-size:13px;color:#47544E;margin:0 0 6px;">Need a quick adjustment? Reply to this email or text <strong>+1 (780) 710-1503</strong>.</p>
      <p style="font-size:12px;color:#6E7A74;margin:0;">LevelUp Cleaning • Est. 2024 • Greater Edmonton, AB • hello@levelupcleaning.ca</p>
    </div>
  `.trim();

  try {
    const response = await fetcher(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [recipient],
        reply_to: 'hello@levelupcleaning.ca',
        subject: `LevelUp Cleaning Edmonton — Reference #${leadId}`,
        html,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
