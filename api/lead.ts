import { onRequestOptions, onRequestPost } from '../functions/api/lead';

export const config = { runtime: 'edge' };

export default async function handler(request: Request): Promise<Response> {
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return onRequestOptions();
  }

  if (method === 'POST') {
    return onRequestPost({
      request,
      env: {
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
        META_PIXEL_ID: process.env.META_PIXEL_ID,
        META_CAPI_TOKEN: process.env.META_CAPI_TOKEN,
        META_TEST_EVENT_CODE: process.env.META_TEST_EVENT_CODE,
      },
    });
  }

  return new Response(JSON.stringify({ ok: false, error: 'Method Not Allowed' }), {
    status: 405,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Allow: 'POST, OPTIONS',
    },
  });
}
