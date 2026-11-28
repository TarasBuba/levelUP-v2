import {
  onRequestGet,
  onRequestOptions,
  onRequestPost,
} from '../functions/api/admin-action';

export const config = { runtime: 'edge' };

function readAdminEnv() {
  return {
    TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
    ADMIN_ACTION_SECRET: process.env.ADMIN_ACTION_SECRET,
    ADMIN_DASHBOARD_SECRET: process.env.ADMIN_DASHBOARD_SECRET,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    META_PIXEL_ID: process.env.META_PIXEL_ID,
    META_CAPI_TOKEN: process.env.META_CAPI_TOKEN,
    META_TEST_EVENT_CODE: process.env.META_TEST_EVENT_CODE,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
  };
}

export default async function handler(request: Request): Promise<Response> {
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return onRequestOptions();
  }

  if (method === 'GET') {
    return onRequestGet({
      request,
      env: readAdminEnv(),
    });
  }

  if (method === 'POST') {
    return onRequestPost({
      request,
      env: readAdminEnv(),
    });
  }

  return new Response(JSON.stringify({ ok: false, error: 'Method Not Allowed' }), {
    status: 405,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Allow: 'GET, POST, OPTIONS',
    },
  });
}
