import type { APIRoute } from 'astro';
import { INDEXABLE_ROUTES, buildCanonicalUrl } from '../lib/seo';

const SITEMAP_LASTMOD = '2026-11-24';

const SERVICE_PATHS = new Set<string>([
  '/move-out-cleaning-edmonton',
  '/deep-cleaning-edmonton',
  '/recurring-cleaning-edmonton',
  '/airbnb-cleaning-edmonton',
]);

function getRoutePriority(route: string): string {
  if (route === '/') {
    return '1.0';
  }
  if (SERVICE_PATHS.has(route)) {
    return '0.9';
  }
  if (route.startsWith('/areas/') || route === '/gift-a-clean') {
    return '0.8';
  }
  if (route === '/guides' || route.startsWith('/guides/')) {
    return '0.7';
  }
  return '0.4';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const GET: APIRoute = () => {
  const urlEntries = INDEXABLE_ROUTES.map((route) => {
    const loc = escapeXml(buildCanonicalUrl(route));
    const priority = getRoutePriority(route);
    return [
      '  <url>',
      `    <loc>${loc}</loc>`,
      `    <lastmod>${SITEMAP_LASTMOD}</lastmod>`,
      `    <priority>${priority}</priority>`,
      '  </url>',
    ].join('\n');
  }).join('\n');

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urlEntries,
    '</urlset>',
    '',
  ].join('\n');

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
