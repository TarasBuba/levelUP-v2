import { onRequestGet } from '../functions/api/slots';

export const config = { runtime: 'edge' };

export default async function handler(request: Request): Promise<Response> {
  if (request.method.toUpperCase() === 'GET') {
    const env =
      process.env.WEEKLY_OPEN_SLOTS !== undefined
        ? {
            LEVELUP_KV: {
              async get() {
                return process.env.WEEKLY_OPEN_SLOTS ?? null;
              },
              async put() {},
            },
          }
        : {};

    return onRequestGet({
      request,
      env,
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
