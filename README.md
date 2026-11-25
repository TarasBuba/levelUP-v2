# LevelUp Cleaning Edmonton — Website & Edge Lead Pipeline

Standalone Astro 5 + Tailwind CSS v4 marketing site, interactive Edmonton pricing calculator, and dual-platform Edge API (`api/*` for Vercel Edge Functions and `functions/api/*` for Cloudflare Pages Functions).

- **Canonical Domain:** `https://levelupcleaning.ca`
- **Phone / SMS:** `+1 (780) 710-1503`
- **Email:** `hello@levelupcleaning.ca`

## Local Development

```bash
pnpm install
pnpm run dev
```

The development server runs at `http://localhost:4321`.

## Verification & Testing

Run the full typecheck, unit test coverage suite, production build, and Playwright end-to-end tests:

```bash
pnpm exec tsc --noEmit
pnpm run verify
pnpm run test:e2e
```

`pnpm run verify` runs:
1. `astro check`
2. `vitest run --coverage` (enforcing `>= 95%` lines/statements/functions/branches coverage across `src/lib/**` and `functions/**`)
3. `astro build` (outputs static bundle to `dist/`)
4. `node scripts/verify-build.mjs` (verifies all 19 routes, `sitemap.xml`, `robots.txt`, `llms.txt`, JSON-LD `@graph`, `< 20 KB` gzipped client JS, `<= 180 KB` photos, zero broken links, zero forbidden claims, and zero leaked secrets)

## Vercel Deployment (`api/*`)

The repository includes [vercel.json](./vercel.json) configured for Astro static output (`pnpm run build` -> `dist`) paired with Vercel Edge Function wrappers in `api/`:

- `api/lead.ts` — `OPTIONS` / `POST` wrapper forwarding to `functions/api/lead.ts`
- `api/slots.ts` — `GET` wrapper forwarding to `functions/api/slots.ts`
- `api/telegram-callback.ts` — `POST` wrapper forwarding to `functions/api/telegram-callback.ts`

### Optional Vercel Environment Variables

All endpoints operate safely in `demo` mode when cloud credentials are omitted. To enable live Telegram lead alerts, Meta Conversions API (CAPI) dispatch, or custom weekly slot counts on Vercel, configure these environment variables in your Vercel project settings:

- `TELEGRAM_BOT_TOKEN` — Telegram Bot API token for admin lead cards and callback responses
- `TELEGRAM_WEBHOOK_SECRET` — Shared secret verified against `X-Telegram-Bot-Api-Secret-Token`
- `META_PIXEL_ID` — Meta Pixel ID for server-side CAPI `Lead` and `Purchase` events
- `META_CAPI_TOKEN` — Meta Conversions API access token
- `META_TEST_EVENT_CODE` — Optional Meta Events Manager test event code
- `WEEKLY_OPEN_SLOTS` — Optional `0`–`9` string override read by `api/slots.ts`

## Cloudflare Pages Deployment (`functions/api/*`)

Cloudflare Pages configuration is preserved in [wrangler.toml](./wrangler.toml) with native Pages Functions under `functions/api/`:

- `functions/api/lead.ts`
- `functions/api/slots.ts`
- `functions/api/telegram-callback.ts`

For local Cloudflare Pages testing, copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill in local test values, or set production secrets via Wrangler:

```bash
wrangler pages secret put TELEGRAM_BOT_TOKEN
wrangler pages secret put TELEGRAM_WEBHOOK_SECRET
wrangler pages secret put META_PIXEL_ID
wrangler pages secret put META_CAPI_TOKEN
```

Bind a KV namespace named `LEVELUP_KV` in `wrangler.toml` to persist `/slots <0-9>` updates from authorized Telegram admins. Never commit `.env` or `.dev.vars` files to version control.
