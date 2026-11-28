import type { PageSeoConfig } from '../types/contracts';

export const SITE_ORIGIN = 'https://levelupcleaning.ca';

export const DEFAULT_OG_IMAGE_PATH = '/media/photos/hero-kitchen-1024w.webp';

export const INDEXABLE_ROUTES = [
  '/',
  '/move-out-cleaning-edmonton',
  '/deep-cleaning-edmonton',
  '/recurring-cleaning-edmonton',
  '/airbnb-cleaning-edmonton',
  '/pricing',
  '/checklist',
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
] as const;

export const NOINDEX_FUNNEL_ROUTES = [
  '/lp/move-out',
  '/lp/deep-reset',
  '/lp/pet-safe',
] as const;

export const NOINDEX_ROUTES = [
  ...NOINDEX_FUNNEL_ROUTES,
  '/admin/calendar',
] as const;

export const CAPITAL_REGION_CITIES = [
  'Edmonton',
  'St. Albert',
  'Sherwood Park',
  'Spruce Grove',
  'Leduc',
  'Beaumont',
  'Fort Saskatchewan',
  'Stony Plain',
  'Devon',
  'Nisku',
] as const;

export function buildCanonicalUrl(path: string): string {
  const raw = (path || '/').trim();
  let pathname = raw;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      pathname = parsed.pathname || '/';
    } catch {
      pathname = '/';
    }
  } else {
    pathname = raw.split(/[?#]/)[0] || '/';
  }

  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }

  pathname = pathname.replace(/\/{2,}/g, '/');

  if (pathname === '/') {
    return `${SITE_ORIGIN}/`;
  }

  const withoutTrailing = pathname.replace(/\/+$/, '');
  return `${SITE_ORIGIN}${withoutTrailing}`;
}

export function resolveOgImageUrl(ogImage?: string): string {
  const candidate = (ogImage || DEFAULT_OG_IMAGE_PATH).trim();
  if (/^https?:\/\//i.test(candidate)) {
    return candidate;
  }
  const normalizedPath = candidate.startsWith('/') ? candidate : `/${candidate}`;
  return `${SITE_ORIGIN}${normalizedPath}`;
}

export function buildJsonLdGraph(config: PageSeoConfig): Record<string, unknown> {
  const canonicalUrl = buildCanonicalUrl(config.canonicalPath);
  const ogImageUrl = resolveOgImageUrl(config.ogImage);
  const orgId = `${SITE_ORIGIN}/#organization`;
  const websiteId = `${SITE_ORIGIN}/#website`;

  const areaServedNodes = CAPITAL_REGION_CITIES.map((city) => ({
    '@type': 'City',
    name: city,
    addressRegion: 'AB',
    addressCountry: 'CA',
  }));

  const cleaningServiceNode: Record<string, unknown> = {
    '@type': 'CleaningService',
    '@id': orgId,
    name: 'LevelUp Cleaning',
    legalName: 'LevelUp Cleaning Services Ltd.',
    url: SITE_ORIGIN,
    logo: `${SITE_ORIGIN}/media/logo-badge.png`,
    image: ogImageUrl,
    telephone: '+1-780-710-1503',
    email: 'hello@levelupcleaning.ca',
    foundingDate: '2024',
    slogan:
      'Level up your space. Next-level eco home & move-out cleaning in Edmonton.',
    priceRange: '$$',
    currenciesAccepted: 'CAD',
    paymentAccepted: 'Interac e-Transfer, Credit Card',
    knowsLanguage: ['en-CA', 'uk'],
    address: {
      '@type': 'PostalAddress',
      addressLocality: 'Edmonton',
      addressRegion: 'AB',
      addressCountry: 'CA',
    },
    geo: {
      '@type': 'GeoCoordinates',
      latitude: 53.5461,
      longitude: -113.4938,
    },
    areaServed: areaServedNodes,
    sameAs: ['https://www.instagram.com/levelupcleaning.yeg/'],
  };

  const webSiteNode: Record<string, unknown> = {
    '@type': 'WebSite',
    '@id': websiteId,
    url: SITE_ORIGIN,
    name: 'LevelUp Cleaning',
    inLanguage: 'en-CA',
    publisher: { '@id': orgId },
  };

  const webPageNode: Record<string, unknown> = {
    '@type': 'WebPage',
    '@id': `${canonicalUrl}#webpage`,
    url: canonicalUrl,
    name: config.title,
    description: config.description,
    inLanguage: 'en-CA',
    isPartOf: { '@id': websiteId },
    about: { '@id': orgId },
    primaryImageOfPage: {
      '@type': 'ImageObject',
      url: ogImageUrl,
    },
  };

  const graph: Array<Record<string, unknown>> = [
    cleaningServiceNode,
    webSiteNode,
    webPageNode,
  ];

  if (config.serviceSchema) {
    graph.push({
      '@type': 'Service',
      '@id': `${canonicalUrl}#service`,
      name: config.serviceSchema.name,
      serviceType: config.serviceSchema.name,
      description: config.serviceSchema.description,
      provider: { '@id': orgId },
      areaServed: areaServedNodes,
      offers: {
        '@type': 'AggregateOffer',
        priceCurrency: 'CAD',
        lowPrice: config.serviceSchema.lowPriceCad,
        highPrice: config.serviceSchema.highPriceCad,
        offerCount: 5,
        availability: 'https://schema.org/InStock',
        url: canonicalUrl,
      },
    });
  }

  if (config.offerCatalogSchema && config.offerCatalogSchema.items.length > 0) {
    graph.push({
      '@type': 'OfferCatalog',
      '@id': `${canonicalUrl}#offer-catalog`,
      name: config.offerCatalogSchema.name,
      description: config.offerCatalogSchema.description,
      url: canonicalUrl,
      provider: { '@id': orgId },
      itemListElement: config.offerCatalogSchema.items.map((item, index) => ({
        '@type': 'Offer',
        position: index + 1,
        priceCurrency: 'CAD',
        price: item.priceCad,
        availability: 'https://schema.org/InStock',
        url: buildCanonicalUrl(item.urlPath),
        itemOffered: {
          '@type': 'Service',
          name: item.name,
          description: item.description,
          provider: { '@id': orgId },
          areaServed: areaServedNodes,
        },
      })),
    });
  }

  if (
    config.checklistItemListSchema &&
    config.checklistItemListSchema.items.length > 0
  ) {
    graph.push({
      '@type': 'ItemList',
      '@id': `${canonicalUrl}#checklist`,
      name: config.checklistItemListSchema.name,
      numberOfItems: config.checklistItemListSchema.items.length,
      itemListElement: config.checklistItemListSchema.items.map(
        (item, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: item,
        }),
      ),
    });
  }

  if (config.faqs && config.faqs.length > 0) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${canonicalUrl}#faq`,
      mainEntity: config.faqs.map((faq) => ({
        '@type': 'Question',
        name: faq.question,
        acceptedAnswer: {
          '@type': 'Answer',
          text: faq.answer,
        },
      })),
    });
  }

  if (config.breadcrumbs && config.breadcrumbs.length > 0) {
    graph.push({
      '@type': 'BreadcrumbList',
      '@id': `${canonicalUrl}#breadcrumb`,
      itemListElement: config.breadcrumbs.map((crumb, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: crumb.name,
        item: buildCanonicalUrl(crumb.path),
      })),
    });
  }

  return {
    '@context': 'https://schema.org',
    '@graph': graph,
  };
}
