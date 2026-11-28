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
        TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
        ADMIN_ACTION_SECRET: process.env.ADMIN_ACTION_SECRET,
        ADMIN_DASHBOARD_SECRET: process.env.ADMIN_DASHBOARD_SECRET,
        META_PIXEL_ID: process.env.META_PIXEL_ID,
        META_CAPI_TOKEN: process.env.META_CAPI_TOKEN,
        META_TEST_EVENT_CODE: process.env.META_TEST_EVENT_CODE,
        UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
        UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
        BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
        GOOGLE_SHEETS_WEBHOOK_URL: process.env.GOOGLE_SHEETS_WEBHOOK_URL,
        RESEND_API_KEY: process.env.RESEND_API_KEY,
        RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
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
