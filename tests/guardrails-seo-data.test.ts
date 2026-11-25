import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_CLAIM_PATTERNS,
  scanForbiddenClaims,
  validateSurfaceSafetyCompliance,
} from '../src/lib/guardrails';
import {
  INDEXABLE_ROUTES,
  NOINDEX_FUNNEL_ROUTES,
  SITE_ORIGIN,
  buildCanonicalUrl,
  buildJsonLdGraph,
  resolveOgImageUrl,
} from '../src/lib/seo';
import { renderLlmsTxt, GET as getLlmsTxt } from '../src/pages/llms.txt';
import { GET as getSitemapXml } from '../src/pages/sitemap.xml';
import strategy from '../src/data/strategy.json';
import siteCopy from '../src/data/site_copy.json';
import mediaManifest from '../src/data/media_manifest.json';

describe('guardrails.ts — Zero-tolerance forbidden claims & surface-safety rules', () => {
  it('detects all 11 forbidden patterns individually and passes approved LevelUp copy', () => {
    expect(FORBIDDEN_CLAIM_PATTERNS).toHaveLength(11);
    expect(scanForbiddenClaims('')).toEqual([]);

    const forbiddenSamples: Array<[string, string]> = [
      ['Backed by $2,000,000 coverage', '$2,000,000'],
      ['Full $2M liability protection', '$2M'],
      ['Fully insured Edmonton cleaners', 'insured'],
      ['Commercial liability insurance included', 'insurance'],
      ['Licensed and bonded crew', 'bonded'],
      ['Active WCB coverage in Alberta', 'WCB'],
      ["Covered by Workers' Compensation Board", "Workers' Compensation"],
      ['24-hour free re-clean promise', 'free re-clean'],
      ['Backed by our re-clean guarantee', 're-clean guarantee'],
      ['Complimentary touch-up guarantee', 'touch-up guarantee'],
      ['Call (780) 555-LVL1 today', '555-LVL1'],
    ];

    for (const [sample, expectedLabel] of forbiddenSamples) {
      expect(scanForbiddenClaims(sample)).toContain(expectedLabel);
    }

    const approvedCopy =
      'LevelUp Cleaning Edmonton (+1 (780) 710-1503): $0 Upfront Deposit, 50-Point Walkthrough Sign-Off, City of Edmonton Licensed, Background-Checked Local Specialists, 100% Pet-Safe Botanical Formulas.';
    expect(scanForbiddenClaims(approvedCopy)).toEqual([]);
  });

  it('enforces complete surface-safety disclaimers whenever DIY chemistry triggers appear', () => {
    expect(validateSurfaceSafetyCompliance('')).toEqual({ valid: true });
    expect(
      validateSurfaceSafetyCompliance(
        'We wipe quartz counters with pH-neutral botanical surfactants.',
      ),
    ).toEqual({ valid: true });

    // Unsafe vinegar / citric acid / baking soda / descaling advice missing warnings
    for (const trigger of ['vinegar', 'citric acid', 'baking soda', 'descaling']) {
      const unsafe = validateSurfaceSafetyCompliance(`Use ${trigger} on your bathroom tiles.`);
      expect(unsafe.valid).toBe(false);
      expect(unsafe.reason).toContain('Surface-safety disclaimer incomplete');
    }

    // Compliant full surface-safety disclaimer
    const compliant =
      'DIY vinegar or citric acid descaling is safe ONLY on sealed ceramic or porcelain tile or chrome mesh; NEVER apply vinegar or acids on marble, travertine, natural stone, quartz, hardwood, unsealed grout, or matte-black/brass fixtures; always spot-test an inconspicuous area first.';
    expect(validateSurfaceSafetyCompliance(compliant)).toEqual({ valid: true });
  });
});

describe('seo.ts, llms.txt, sitemap.xml, and JSON data integrity', () => {
  it('maintains 16 indexable routes and 3 noindex funnel routes with normalized canonical URLs', () => {
    expect(SITE_ORIGIN).toBe('https://levelupcleaning.ca');
    expect(INDEXABLE_ROUTES).toHaveLength(16);
    expect(NOINDEX_FUNNEL_ROUTES).toEqual(['/lp/move-out', '/lp/deep-reset', '/lp/pet-safe']);

    for (const lp of NOINDEX_FUNNEL_ROUTES) {
      expect(INDEXABLE_ROUTES).not.toContain(lp);
    }

    expect(buildCanonicalUrl('/')).toBe('https://levelupcleaning.ca/');
    expect(buildCanonicalUrl('')).toBe('https://levelupcleaning.ca/');
    expect(buildCanonicalUrl('move-out-cleaning-edmonton/')).toBe(
      'https://levelupcleaning.ca/move-out-cleaning-edmonton',
    );
    expect(buildCanonicalUrl('/guides//edmonton-winter-salt-floor-safety/?promo=50#top')).toBe(
      'https://levelupcleaning.ca/guides/edmonton-winter-salt-floor-safety',
    );
    expect(buildCanonicalUrl('https://levelupcleaning.ca/privacy/')).toBe(
      'https://levelupcleaning.ca/privacy',
    );
    expect(buildCanonicalUrl('https://[invalid-url')).toBe('https://levelupcleaning.ca/');

    expect(resolveOgImageUrl()).toBe(
      'https://levelupcleaning.ca/media/photos/hero-kitchen-1024w.webp',
    );
    expect(resolveOgImageUrl('media/logo-badge.png')).toBe(
      'https://levelupcleaning.ca/media/logo-badge.png',
    );
    expect(resolveOgImageUrl('https://cdn.levelupcleaning.ca/og.webp')).toBe(
      'https://cdn.levelupcleaning.ca/og.webp',
    );
  });

  it('builds Schema.org @graph with CleaningService, Service+Offer, FAQPage, and BreadcrumbList', () => {
    const fullGraph = buildJsonLdGraph({
      title: 'Move-Out Cleaning Edmonton | LevelUp Cleaning',
      description: 'Alberta RTA Move-Out inspection cleaning from $235 CAD pre-tax.',
      canonicalPath: '/move-out-cleaning-edmonton',
      serviceSchema: {
        name: 'Move-Out / Move-In Inspection Clean',
        description: 'Includes inside oven, fridge, and cabinets FREE.',
        lowPriceCad: 235,
        highPriceCad: 575,
      },
      faqs: [
        {
          question: 'Are inside oven, fridge, and cabinets included?',
          answer: 'Yes, all three are included FREE ($135 value).',
        },
      ],
      breadcrumbs: [
        { name: 'Home', path: '/' },
        { name: 'Move-Out Cleaning Edmonton', path: '/move-out-cleaning-edmonton' },
      ],
    });

    expect(fullGraph['@context']).toBe('https://schema.org');
    const nodes = fullGraph['@graph'] as Array<Record<string, unknown>>;
    const types = nodes.map((n) => n['@type']);
    expect(types).toEqual([
      'CleaningService',
      'WebSite',
      'WebPage',
      'Service',
      'FAQPage',
      'BreadcrumbList',
    ]);
    expect(scanForbiddenClaims(JSON.stringify(fullGraph))).toEqual([]);

    const minimalGraph = buildJsonLdGraph({
      title: 'Privacy Policy',
      description: 'Alberta PIPA and CASL privacy notice.',
      canonicalPath: '/privacy',
    });
    expect((minimalGraph['@graph'] as unknown[]).length).toBe(3);
  });

  it('verifies llms.txt, sitemap.xml, strategy.json, site_copy.json, and media_manifest.json', async () => {
    const llmsText = renderLlmsTxt();
    expect(llmsText).toContain('+1 (780) 710-1503');
    expect(llmsText).toContain('hello@levelupcleaning.ca');
    expect(llmsText).toContain('$120–$575');
    expect(scanForbiddenClaims(llmsText)).toEqual([]);
    expect(validateSurfaceSafetyCompliance(llmsText)).toEqual({ valid: true });

    const llmsRes = await getLlmsTxt({} as never);
    expect(llmsRes.status).toBe(200);
    expect(await llmsRes.text()).toBe(llmsText);

    const sitemapRes = await getSitemapXml({} as never);
    expect(sitemapRes.status).toBe(200);
    const sitemapXml = await sitemapRes.text();
    for (const route of INDEXABLE_ROUTES) {
      expect(sitemapXml).toContain(`<loc>${buildCanonicalUrl(route)}</loc>`);
    }
    for (const lp of NOINDEX_FUNNEL_ROUTES) {
      expect(sitemapXml).not.toContain(lp);
    }

    // Zero forbidden claims across all 3 JSON data files
    expect(scanForbiddenClaims(JSON.stringify(strategy))).toEqual([]);
    expect(scanForbiddenClaims(JSON.stringify(siteCopy))).toEqual([]);
    expect(scanForbiddenClaims(JSON.stringify(mediaManifest))).toEqual([]);

    // Every guide's surfaceSafetyWarning satisfies surface-safety compliance
    for (const guide of siteCopy.guides) {
      const check = validateSurfaceSafetyCompliance(guide.surfaceSafetyWarning);
      expect(check).toEqual({ valid: true });
    }

    // Every asset in media_manifest.json exists on disk under website/public
    const publicRoot = resolve(__dirname, '../public');
    for (const brandAsset of Object.values(mediaManifest.brandAssets)) {
      expect(existsSync(resolve(publicRoot, `.${brandAsset.path}`))).toBe(true);
    }
    for (const photo of Object.values(mediaManifest.photos)) {
      expect(existsSync(resolve(publicRoot, `.${photo.fallback.path}`))).toBe(true);
      for (const variant of Object.values(photo.variants)) {
        expect(existsSync(resolve(publicRoot, `.${variant.avif.path}`))).toBe(true);
        expect(existsSync(resolve(publicRoot, `.${variant.webp.path}`))).toBe(true);
      }
    }
    for (const vid of Object.values(mediaManifest.videos)) {
      expect(existsSync(resolve(publicRoot, `.${vid.mp4.path}`))).toBe(true);
      expect(existsSync(resolve(publicRoot, `.${vid.poster.avif.path}`))).toBe(true);
      expect(existsSync(resolve(publicRoot, `.${vid.poster.webp.path}`))).toBe(true);
    }
  });
});
