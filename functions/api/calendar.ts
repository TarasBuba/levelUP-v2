import {
  type CalendarStoreEnv,
  getCalendarSchedule,
} from '../../src/lib/calendar-store';

export interface CalendarFunctionContext {
  request: Request;
  env?: CalendarStoreEnv;
  params?: Record<string, string | string[]>;
  waitUntil?: (promise: Promise<unknown>) => void;
  fetchImpl?: typeof fetch;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': 'https://levelupcleaning.ca',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export async function onRequestGet(context: CalendarFunctionContext): Promise<Response> {
  const schedule = await getCalendarSchedule(context.env, {
    fetchImpl: context.fetchImpl,
  });

  return new Response(JSON.stringify(schedule), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}
