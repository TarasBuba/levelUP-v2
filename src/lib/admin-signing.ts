import type { ServiceId, SlotWindow } from '../types/contracts';

export type AdminActionType = 'confirm_slot' | 'release_slot' | 'confirm_price' | 'mark_paid';

export interface SignedAdminPayload {
  action: AdminActionType;
  leadId: string;
  date?: string;
  window?: SlotWindow;
  amountCad?: number;
  service?: ServiceId;
  phone?: string;
  name?: string;
  exp?: number;
}

const VALID_ACTIONS: readonly AdminActionType[] = [
  'confirm_slot',
  'release_slot',
  'confirm_price',
  'mark_paid',
];

const DEFAULT_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function computeHmacBase64Url(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toBase64Url(new Uint8Array(signature));
}

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    globalThis.crypto.subtle.digest('SHA-256', encoder.encode(String(a ?? ''))),
    globalThis.crypto.subtle.digest('SHA-256', encoder.encode(String(b ?? ''))),
  ]);
  const bytesA = new Uint8Array(hashA);
  const bytesB = new Uint8Array(hashB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i += 1) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

export async function createSignedAdminToken(
  payload: SignedAdminPayload,
  secret: string,
): Promise<string> {
  const cleanSecret = String(secret ?? '').trim();
  if (!cleanSecret) {
    throw new Error('Admin signing secret is required.');
  }
  const nowUnix = Math.floor(Date.now() / 1000);
  const fullPayload: SignedAdminPayload = {
    ...payload,
    exp: typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? Math.floor(payload.exp)
      : nowUnix + DEFAULT_TOKEN_TTL_SECONDS,
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(fullPayload));
  const payloadSegment = toBase64Url(payloadBytes);
  const signatureSegment = await computeHmacBase64Url(payloadSegment, cleanSecret);
  return `${payloadSegment}.${signatureSegment}`;
}

export async function verifySignedAdminToken(
  token: string,
  secret: string,
  nowUnix?: number,
): Promise<{ valid: true; payload: SignedAdminPayload } | { valid: false; error: string }> {
  const cleanSecret = String(secret ?? '').trim();
  if (!cleanSecret) {
    return { valid: false, error: 'Signing secret is not configured.' };
  }
  const cleanToken = String(token ?? '').trim();
  const segments = cleanToken.split('.');
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    return { valid: false, error: 'Malformed admin action token.' };
  }

  const [payloadSegment, signatureSegment] = segments;
  const expectedSignature = await computeHmacBase64Url(payloadSegment, cleanSecret);
  const signaturesMatch = await constantTimeEqual(signatureSegment, expectedSignature);
  if (!signaturesMatch) {
    return { valid: false, error: 'Invalid admin action signature.' };
  }

  let parsed: unknown;
  try {
    const decoded = new TextDecoder().decode(fromBase64Url(payloadSegment));
    parsed = JSON.parse(decoded);
  } catch {
    return { valid: false, error: 'Corrupted admin action payload.' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, error: 'Invalid admin action payload object.' };
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.action !== 'string' ||
    !(VALID_ACTIONS as readonly string[]).includes(candidate.action)
  ) {
    return { valid: false, error: 'Unsupported admin action type.' };
  }

  if (typeof candidate.leadId !== 'string' || candidate.leadId.trim().length === 0) {
    return { valid: false, error: 'Missing lead identifier in admin token.' };
  }

  const checkUnix =
    typeof nowUnix === 'number' && Number.isFinite(nowUnix)
      ? Math.floor(nowUnix)
      : Math.floor(Date.now() / 1000);

  if (typeof candidate.exp !== 'number' || !Number.isFinite(candidate.exp) || candidate.exp < checkUnix) {
    return { valid: false, error: 'Admin action link has expired.' };
  }

  return {
    valid: true,
    payload: candidate as unknown as SignedAdminPayload,
  };
}

export async function buildSignedAdminUrl(
  origin: string,
  payload: SignedAdminPayload,
  secret: string,
): Promise<string> {
  const cleanOrigin = String(origin ?? '').trim().replace(/\/+$/, '') || 'https://levelupcleaning.ca';
  const token = await createSignedAdminToken(payload, secret);
  return `${cleanOrigin}/api/admin-action?token=${encodeURIComponent(token)}`;
}
