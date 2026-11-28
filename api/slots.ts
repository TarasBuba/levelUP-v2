import { onRequestGet } from '../functions/api/slots';

export const config = { runtime: 'edge' };

export default async function handler(request: Request): Promise<Response> {
  if (request.method.toUpperCase() === 'GET') {
    const kvShim =
      process.env.WEEKLY_OPEN_SLOTS !== undefined
        ? {
            async get(key: string) {
              if (key === 'weekly_open_slots') {
                return process.env.WEEKLY_OPEN_SLOTS ?? null;
              }
              return null;
            },
            async put() {},
          }
        : undefined;

    return onRequestGet({
      request,
      env: {
        ...(kvShim ? { LEVELUP_KV: kvShim } : {}),
        UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
        UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
        BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
      },
    });
  }

  return new Response(JSON.stringify({ ok: false, error: 'Method Not Allowed' }), {
    status: 405,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Allow: 'GET',
    },
  });
}
