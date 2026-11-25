import { getSlotsStatus, type KvNamespaceLike } from '../../src/lib/slots';

export interface SlotsEnv {
  LEVELUP_KV?: KvNamespaceLike;
}

export interface SlotsFunctionContext {
  request: Request;
  env?: SlotsEnv;
  params?: Record<string, string | string[]>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export async function onRequestGet(context: SlotsFunctionContext): Promise<Response> {
  let rawValue: unknown = undefined;

  try {
    if (context.env?.LEVELUP_KV) {
      rawValue = await context.env.LEVELUP_KV.get('weekly_open_slots');
    }
  } catch {
    rawValue = undefined;
  }

  const status = getSlotsStatus(rawValue);

  return new Response(JSON.stringify(status), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
