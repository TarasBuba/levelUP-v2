import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const distDir = resolve(__dirname, '../dist');

const EXPECTED_INDEXABLE_ROUTES = [
  '/',
  '/move-out-cleaning-edmonton',
  '/deep-cleaning-edmonton',
  '/recurring-cleaning-edmonton',
  '/airbnb-cleaning-edmonton',
  '/areas/central-edmonton-condos',
  '/areas/southwest-edmonton-homes',
  '/areas/west-mature-edmonton',
  '/areas/st-albert-sherwood-park',
  '/guides',
  '/guides/edmonton-winter-salt-floor-safety',
  '/guides/why-oven-self-clean-destroys-control-boards',
  '/guides/edmonton-hard-water-matte-black-fixtures',
  '/guides/alberta-move-out-inspection-checklist',
  '/gift-a-clean',
  '/privacy',
];

const EXPECTED_LP_ROUTES = ['/lp/move-out', '/lp/deep-reset', '/lp/pet-safe'];

const ALL_EXPECTED_ROUTES = [...EXPECTED_INDEXABLE_ROUTES, ...EXPECTED_LP_ROUTES];

const FORBIDDEN_CLAIM_RULES = [
  { label: '$2,000,000', regex: /\$2,000,000(?!\d)/i },
  { label: '$2M', regex: /\$2\s*M\b/i },
  { label: 'insured', regex: /\binsured\b/i },
  { label: 'insurance', regex: /\binsurance\b/i },
  { label: 'bonded', regex: /\bbonded\b/i },
  { label: 'WCB', regex: /\bWCB\b/i },
  { label: "Workers' Compensation", regex: /workers['’]?\s+compensation/i },
  { label: 'free re-clean', regex: /free\s+re-?clean/i },
  { label: 're-clean guarantee', regex: /re-?clean\s+guarantee/i },
  { label: 'touch-up guarantee', regex: /touch-?up\s+guarantee/i },
  { label: '555-LVL1', regex: /555-LVL1/i },
];

const SECRET_LEAK_RULES = [
  { label: 'TELEGRAM_BOT_TOKEN', regex: /TELEGRAM_BOT_TOKEN/ },
  { label: 'META_CAPI_TOKEN', regex: /META_CAPI_TOKEN/ },
  { label: 'whsec secret', regex: /\bwhsec[_A-Za-z0-9-]*/ },
  { label: 'Telegram bot token literal', regex: /bot\d+:[A-Za-z0-9_-]{30,}/ },
];

const TEXT_SCAN_EXTENSIONS = new Set(['.html', '.js', '.css', '.txt', '.xml', '.mjs', '.json']);
const MAX_GZIP_JS_BYTES = 20 * 1024; // 20,480 bytes
const MAX_PHOTO_BYTES = 180 * 1024; // 184,320 bytes

function walkFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function routeToHtmlPath(route) {
  if (route === '/') {
    return join(distDir, 'index.html');
  }
  const clean = route.replace(/^\/+/, '').replace(/\/+$/, '');
  return join(distDir, clean, 'index.html');
}

function resolveInternalDistTarget(rawRef) {
  const trimmed = rawRef.trim();
  if (
    !trimmed ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:') ||
    trimmed.startsWith('sms:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('data:')
  ) {
    return null;
  }

  const withoutQueryHash = trimmed.split(/[?#]/)[0];
  if (!withoutQueryHash || withoutQueryHash.startsWith('/api/')) {
    return null;
  }

  if (!withoutQueryHash.startsWith('/')) {
    return null;
  }

  if (withoutQueryHash === '/') {
    return [join(distDir, 'index.html')];
  }

  const relPath = withoutQueryHash.replace(/^\/+/, '').replace(/\/+$/, '');
  return [
    join(distDir, relPath),
    join(distDir, relPath, 'index.html'),
    join(distDir, `${relPath}.html`),
  ];
}

const errors = [];

if (!existsSync(distDir)) {
  console.error(`[verify-build] FAIL: dist directory does not exist at ${distDir}`);
  process.exit(1);
}

// 1. Verify all 19 HTML pages + sitemap.xml + robots.txt + llms.txt
for (const route of ALL_EXPECTED_ROUTES) {
  const htmlPath = routeToHtmlPath(route);
  if (!existsSync(htmlPath)) {
    errors.push(`Missing built HTML page for route "${route}" (${relative(distDir, htmlPath)})`);
  }
}

const allDistFiles = walkFiles(distDir);
const htmlFiles = allDistFiles.filter((f) => extname(f).toLowerCase() === '.html');
if (htmlFiles.length !== 19) {
  errors.push(`Expected exactly 19 HTML pages in dist/, found ${htmlFiles.length}`);
}

for (const metaFile of ['sitemap.xml', 'robots.txt', 'llms.txt']) {
  const full = join(distDir, metaFile);
  if (!existsSync(full)) {
    errors.push(`Missing required root file dist/${metaFile}`);
  }
}

// 2 & 3. Scan ALL text outputs for forbidden claims and leaked .env secrets
for (const filePath of allDistFiles) {
  const ext = extname(filePath).toLowerCase();
  if (!TEXT_SCAN_EXTENSIONS.has(ext)) continue;

  const content = readFileSync(filePath, 'utf8');
  const rel = relative(distDir, filePath).replace(/\\/g, '/');

  for (const rule of FORBIDDEN_CLAIM_RULES) {
    if (rule.regex.test(content)) {
      errors.push(`Forbidden claim "${rule.label}" matched in dist/${rel}`);
    }
  }

  for (const secretRule of SECRET_LEAK_RULES) {
    if (secretRule.regex.test(content)) {
      errors.push(`Potential secret leak (${secretRule.label}) matched in dist/${rel}`);
    }
  }
}

// 4 & 8. Validate parsable JSON-LD @graph AND zero broken internal src/href/poster/srcset paths on every HTML page
let verifiedInternalRefs = 0;

for (const htmlPath of htmlFiles) {
  const rel = relative(distDir, htmlPath).replace(/\\/g, '/');
  const html = readFileSync(htmlPath, 'utf8');

  const ldMatches = [
    ...html.matchAll(/<script\b[^>]*type=(['"])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi),
  ];

  if (ldMatches.length === 0) {
    errors.push(`Missing <script type="application/ld+json"> on dist/${rel}`);
  } else {
    for (const match of ldMatches) {
      try {
        const parsed = JSON.parse(match[2]);
        if (parsed['@context'] !== 'https://schema.org' || !Array.isArray(parsed['@graph']) || parsed['@graph'].length === 0) {
          errors.push(`Invalid JSON-LD @graph structure in dist/${rel}`);
        }
      } catch (err) {
        errors.push(`Unparsable JSON-LD in dist/${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Check src, href, poster attributes
  const attrMatches = [...html.matchAll(/\b(?:src|href|poster)=(['"])(.*?)\1/gi)];
  for (const [, , rawVal] of attrMatches) {
    const candidates = resolveInternalDistTarget(rawVal);
    if (!candidates) continue;
    verifiedInternalRefs += 1;
    if (!candidates.some((c) => existsSync(c))) {
      errors.push(`Broken internal reference "${rawVal}" in dist/${rel}`);
    }
  }

  // Check srcset descriptors
  const srcsetMatches = [...html.matchAll(/\bsrcset=(['"])(.*?)\1/gi)];
  for (const [, , srcsetVal] of srcsetMatches) {
    const entries = srcsetVal
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
    for (const urlPart of entries) {
      const candidates = resolveInternalDistTarget(urlPart);
      if (!candidates) continue;
      verifiedInternalRefs += 1;
      if (!candidates.some((c) => existsSync(c))) {
        errors.push(`Broken internal srcset asset "${urlPart}" in dist/${rel}`);
      }
    }
  }
}

// 5. Verify /lp/* noindex tag, zero sitemap.xml presence, and zero nav exit links
const sitemapPath = join(distDir, 'sitemap.xml');
const sitemapContent = existsSync(sitemapPath) ? readFileSync(sitemapPath, 'utf8') : '';

for (const lpRoute of EXPECTED_LP_ROUTES) {
  if (sitemapContent.includes(lpRoute)) {
    errors.push(`Funnel route "${lpRoute}" must NOT appear in dist/sitemap.xml`);
  }

  const lpHtmlPath = routeToHtmlPath(lpRoute);
  if (!existsSync(lpHtmlPath)) continue;

  const lpHtml = readFileSync(lpHtmlPath, 'utf8');
  const hasNoindex =
    /<meta\b[^>]*name=(['"])robots\1[^>]*content=(['"])[^'"]*noindex[^'"]*\2/i.test(lpHtml) ||
    /<meta\b[^>]*content=(['"])[^'"]*noindex[^'"]*\1[^>]*name=(['"])robots\2/i.test(lpHtml);

  if (!hasNoindex) {
    errors.push(`${lpRoute} is missing <meta name="robots" content="noindex...">`);
  }

  if (/<nav\b/i.test(lpHtml)) {
    errors.push(`${lpRoute} contains a <nav> element (must be distraction-free AdFunnelLayout)`);
  }

  const headerMatch = lpHtml.match(/<header\b[\s\S]*?<\/header>/i);
  if (headerMatch) {
    const headerHrefs = [...headerMatch[0].matchAll(/<a\b[^>]*href=(['"])(.*?)\1/gi)].map(
      (m) => m[2],
    );
    for (const href of headerHrefs) {
      if (!href.startsWith('#')) {
        errors.push(`${lpRoute} header contains nav exit link href="${href}"`);
      }
    }
  }
}

// 6. Verify total gzipped client JS across dist/_astro/*.js is < 20 KB (20,480 bytes)
const astroAssetsDir = join(distDir, '_astro');
const jsFiles = existsSync(astroAssetsDir)
  ? walkFiles(astroAssetsDir).filter((f) => extname(f).toLowerCase() === '.js')
  : [];

let totalRawJsBytes = 0;
let totalGzipJsBytes = 0;

for (const jsFile of jsFiles) {
  const buf = readFileSync(jsFile);
  totalRawJsBytes += buf.byteLength;
  totalGzipJsBytes += gzipSync(buf, { level: 9 }).byteLength;
}

if (totalGzipJsBytes >= MAX_GZIP_JS_BYTES) {
  errors.push(
    `Total gzipped client JS (${totalGzipJsBytes} bytes) exceeds 20 KB (${MAX_GZIP_JS_BYTES} bytes) budget`,
  );
}

// 7. Verify static photo assets in dist/media/photos/* are each <= 180 KB and raw photos/raw/ is absent
const photosDir = join(distDir, 'media', 'photos');
const rawPhotosDirs = [
  join(distDir, 'media', 'photos', 'raw'),
  join(distDir, 'photos', 'raw'),
];

for (const rawDir of rawPhotosDirs) {
  if (existsSync(rawDir)) {
    errors.push(`Raw unoptimized directory must not exist in build output: ${relative(distDir, rawDir)}`);
  }
}

const photoFiles = walkFiles(photosDir);
let maxPhotoSeenBytes = 0;
if (photoFiles.length === 0) {
  errors.push('No optimized photos found in dist/media/photos/');
}

for (const photoPath of photoFiles) {
  const size = statSync(photoPath).size;
  if (size > maxPhotoSeenBytes) maxPhotoSeenBytes = size;
  if (size > MAX_PHOTO_BYTES) {
    errors.push(
      `Photo dist/${relative(distDir, photoPath).replace(/\\/g, '/')} is ${size} bytes (> 180 KB limit)`,
    );
  }
}

if (errors.length > 0) {
  console.error(`\n[verify-build] FAILED with ${errors.length} error(s):`);
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log(
  [
    `[verify-build] PASSED deterministic dist/ verification:`,
    `  - HTML routes: ${htmlFiles.length}/19 (+ sitemap.xml, robots.txt, llms.txt)`,
    `  - Forbidden claims & secret leaks: 0 across ${allDistFiles.length} built files`,
    `  - JSON-LD @graph & /lp/* noindex + zero exit-nav isolation: verified`,
    `  - Client JS bundle (${jsFiles.length} chunks): ${(totalGzipJsBytes / 1024).toFixed(2)} KB gzipped (${totalGzipJsBytes}/${MAX_GZIP_JS_BYTES} bytes; raw ${(totalRawJsBytes / 1024).toFixed(2)} KB)`,
    `  - Static photos (${photoFiles.length} files): max ${(maxPhotoSeenBytes / 1024).toFixed(1)} KB (<= 180 KB), raw/ absent`,
    `  - Internal asset & route links verified: ${verifiedInternalRefs} (0 broken)`,
  ].join('\n'),
);
