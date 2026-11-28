import {
  type LeadPipelineEnv,
  processLeadSubmission,
  validateLeadPayload,
} from '../../src/lib/lead-pipeline';
import type { LeadSubmissionResult } from '../../src/types/contracts';

export interface PagesFunctionContext<Env = LeadPipelineEnv> {
  request: Request;
  env: Env;
  params?: Record<string, string | string[]>;
  waitUntil?: (promise: Promise<unknown>) => void;
  fetchImpl?: typeof fetch;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': 'https://levelupcleaning.ca',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(
  payload: LeadSubmissionResult | Record<string, unknown>,
  status: number,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export async function onRequestPost(
  context: PagesFunctionContext<LeadPipelineEnv>,
): Promise<Response> {
  const contentLengthHeader = context.request.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > 8_000_000) {
      return jsonResponse(
        {
          ok: false,
          leadId: '',
          finalPreTaxCad: 0,
          areaName: '',
          smsPrefillHref: 'sms:+17807101503',
          telegramDispatched: false,
          capiDispatched: false,
          mode: 'demo',
          error: 'Request payload exceeds maximum allowed size.',
        },
        400,
      );
    }
  }

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return jsonResponse(
      {
        ok: false,
        leadId: '',
        finalPreTaxCad: 0,
        areaName: '',
        smsPrefillHref: 'sms:+17807101503',
        telegramDispatched: false,
        capiDispatched: false,
        mode: 'demo',
        error: 'Malformed JSON body.',
      },
      400,
    );
  }

  const validation = validateLeadPayload(body);
  if (!validation.valid) {
    const hasSecrets = Boolean(
      context.env?.TELEGRAM_BOT_TOKEN?.trim() ||
        (context.env?.META_PIXEL_ID?.trim() && context.env?.META_CAPI_TOKEN?.trim()),
    );
    return jsonResponse(
      {
        ok: false,
        leadId: '',
        finalPreTaxCad: 0,
        areaName: '',
        smsPrefillHref: 'sms:+17807101503',
        telegramDispatched: false,
        capiDispatched: false,
        mode: hasSecrets ? 'live' : 'demo',
        error: validation.error,
      },
      400,
    );
  }

  const clientIpAddress =
    context.request.headers.get('CF-Connecting-IP') ??
    context.request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    undefined;

  const clientUserAgent = context.request.headers.get('User-Agent') ?? undefined;
  const referer = context.request.headers.get('Referer') ?? undefined;

  const result = await processLeadSubmission(validation.data, context.env, {
    clientIpAddress,
    clientUserAgent,
    eventSourceUrl: referer,
    fetchImpl: context.fetchImpl,
  });

  if (!result.ok) {
    const isSlotConflict = Boolean(
      result.error &&
        (result.error.includes('already booked') || result.error.includes('just booked')),
    );
    return jsonResponse(result, isSlotConflict ? 409 : 400);
  }

  return jsonResponse(result, 200);
}
