export type CapiEventName = 'Lead' | 'Purchase' | 'ViewContent';

export type CapiActionSource =
  | 'website'
  | 'system_generated'
  | 'chat'
  | 'phone_call'
  | 'other';

export interface CapiEventInput {
  eventName: CapiEventName;
  eventId?: string;
  eventTime?: number;
  actionSource?: CapiActionSource;
  eventSourceUrl?: string;
  value?: number;
  currency?: 'CAD';
  contentName?: string;
  contentCategory?: string;
  phone?: string;
  email?: string;
  postalCode?: string;
  fbp?: string;
  fbc?: string;
  fbclid?: string;
  clientIpAddress?: string;
  clientUserAgent?: string;
  externalId?: string;
  testEventCode?: string;
}

export interface MetaCapiUserData {
  ph?: string[];
  em?: string[];
  zp?: string[];
  country?: string[];
  external_id?: string[];
  fbp?: string;
  fbc?: string;
  client_ip_address?: string;
  client_user_agent?: string;
}

export interface MetaCapiEventItem {
  event_name: CapiEventName;
  event_time: number;
  event_id: string;
  action_source: CapiActionSource;
  event_source_url?: string;
  user_data: MetaCapiUserData;
  custom_data: {
    currency: 'CAD';
    value: number;
    content_name?: string;
    content_category?: string;
  };
}

export interface MetaCapiPayload {
  data: [MetaCapiEventItem];
  test_event_code?: string;
}

export interface CapiEnv {
  META_PIXEL_ID?: string;
  META_CAPI_TOKEN?: string;
  META_TEST_EVENT_CODE?: string;
}

export interface CapiDispatchResult {
  dispatched: boolean;
  status?: number;
  reason?: string;
}

export async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(String(value ?? ''));
  const digestBuffer = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(digestBuffer);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizePhoneDigits(phone: string): string {
  const rawDigits = String(phone ?? '').replace(/\D+/g, '');
  if (!rawDigits) {
    return '';
  }
  const strippedIntlPrefix =
    rawDigits.startsWith('00') && rawDigits.length > 11 ? rawDigits.slice(2) : rawDigits;

  if (strippedIntlPrefix.length === 10) {
    return `1${strippedIntlPrefix}`;
  }
  return strippedIntlPrefix;
}

export async function buildCapiEventPayload(input: CapiEventInput): Promise<MetaCapiPayload> {
  const eventTime =
    typeof input.eventTime === 'number' && Number.isFinite(input.eventTime)
      ? Math.floor(input.eventTime)
      : Math.floor(Date.now() / 1000);

  const eventId = input.eventId?.trim() || globalThis.crypto.randomUUID();
  const actionSource: CapiActionSource =
    input.actionSource ?? (input.eventName === 'Purchase' ? 'system_generated' : 'website');

  const userData: MetaCapiUserData = {
    country: [await sha256Hex('ca')],
  };

  if (input.phone) {
    const normalizedPhone = normalizePhoneDigits(input.phone);
    if (normalizedPhone) {
      userData.ph = [await sha256Hex(normalizedPhone)];
    }
  }

  if (input.email) {
    const normalizedEmail = input.email.trim().toLowerCase();
    if (normalizedEmail) {
      userData.em = [await sha256Hex(normalizedEmail)];
    }
  }

  if (input.postalCode) {
    const normalizedFsa = input.postalCode
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '')
      .slice(0, 3);
    if (normalizedFsa) {
      userData.zp = [await sha256Hex(normalizedFsa)];
    }
  }

  if (input.externalId?.trim()) {
    userData.external_id = [await sha256Hex(input.externalId.trim().toLowerCase())];
  }

  if (input.fbp?.trim()) {
    userData.fbp = input.fbp.trim();
  }

  if (input.fbc?.trim()) {
    userData.fbc = input.fbc.trim();
  } else if (input.fbclid?.trim()) {
    userData.fbc = `fb.1.${eventTime * 1000}.${input.fbclid.trim()}`;
  }

  if (input.clientIpAddress?.trim()) {
    userData.client_ip_address = input.clientIpAddress.trim();
  }

  if (input.clientUserAgent?.trim()) {
    userData.client_user_agent = input.clientUserAgent.trim();
  }

  const numericValue =
    typeof input.value === 'number' && Number.isFinite(input.value)
      ? Math.max(0, Math.round(input.value * 100) / 100)
      : 0;

  const eventItem: MetaCapiEventItem = {
    event_name: input.eventName,
    event_time: eventTime,
    event_id: eventId,
    action_source: actionSource,
    ...(input.eventSourceUrl?.trim() ? { event_source_url: input.eventSourceUrl.trim() } : {}),
    user_data: userData,
    custom_data: {
      currency: 'CAD',
      value: numericValue,
      ...(input.contentName?.trim() ? { content_name: input.contentName.trim() } : {}),
      ...(input.contentCategory?.trim() ? { content_category: input.contentCategory.trim() } : {}),
    },
  };

  const payload: MetaCapiPayload = {
    data: [eventItem],
  };

  if (input.testEventCode?.trim()) {
    payload.test_event_code = input.testEventCode.trim();
  }

  return payload;
}

export async function dispatchMetaCapiEvent(
  payload: MetaCapiPayload,
  env?: CapiEnv,
  fetchImpl?: typeof fetch,
): Promise<CapiDispatchResult> {
  const pixelId = env?.META_PIXEL_ID?.trim() ?? '';
  const accessToken = env?.META_CAPI_TOKEN?.trim() ?? '';

  if (!pixelId || !accessToken) {
    return { dispatched: false, reason: 'missing_credentials' };
  }

  const fetcher = fetchImpl ?? globalThis.fetch;
  const endpoint = `https://graph.facebook.com/v21.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`;

  const bodyToSend: MetaCapiPayload =
    env?.META_TEST_EVENT_CODE?.trim() && !payload.test_event_code
      ? { ...payload, test_event_code: env.META_TEST_EVENT_CODE.trim() }
      : payload;

  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyToSend),
    });

    if (!response.ok) {
      return {
        dispatched: false,
        status: response.status,
        reason: 'http_error',
      };
    }

    return {
      dispatched: true,
      status: response.status,
    };
  } catch {
    return {
      dispatched: false,
      reason: 'network_error',
    };
  }
}
