export type ServiceId = 'move_out' | 'deep_clean' | 'regular' | 'airbnb' | 'hourly';

export type PackageServiceId = Exclude<ServiceId, 'hourly'>;

export type Frequency = 'one_time' | 'weekly' | 'biweekly' | 'monthly';

export type AddonId =
  | 'inside_oven'
  | 'inside_fridge'
  | 'inside_cabinets'
  | 'interior_windows'
  | 'wall_spot_wash'
  | 'heavy_pet_hair'
  | 'basement_suite';

export interface PromoPreset {
  code: string;
  discountCad: number;
  badge: string;
  minSubtotalCad?: number;
}

export interface PromoTier {
  minSubtotalCad: number;
  discountCad: number;
  badge: string;
}

export interface PromoResolution {
  appliedCode: string;
  discountCad: number;
  badge: string;
  isUrlOverride: boolean;
}

export interface PostalLookupResult {
  valid: boolean;
  normalizedFsa: string;
  areaName: string;
  municipality: string;
  zoneLabel: string;
  travelFeeCad: number;
  message: string;
}

export interface QuoteInput {
  mode: 'flat_rate' | 'hourly';
  service: ServiceId;
  bedrooms?: number;
  bathrooms?: number;
  frequency?: Frequency;
  addons?: AddonId[];
  hours?: number;
  cleaners?: number;
  postalCode?: string;
  promoQuery?: string | null;
}

export interface AddonBreakdownItem {
  id: AddonId;
  label: string;
  regularPriceCad: number;
  chargedPriceCad: number;
  includedFree: boolean;
}

export interface QuoteBreakdown {
  mode: 'flat_rate' | 'hourly';
  service: ServiceId;
  serviceTitle: string;
  basePriceCad: number;
  extraBathroomFeeCad: number;
  addonsTotalCad: number;
  includedFreeSavingsCad: number;
  addonsDetail: AddonBreakdownItem[];
  travelFeeCad: number;
  subtotalBeforeDiscountsCad: number;
  frequencyDiscountPct: number;
  frequencyDiscountCad: number;
  promo: PromoResolution;
  finalPreTaxCad: number;
  estimatedGstCad: number;
  competitorMedianCad: number;
  competitorSavingsCad: number;
}

export interface SnapPhotoAttachment {
  filename: string;
  mimeType: string;
  base64Data: string;
}

export interface AttributionData {
  fbclid?: string;
  fbp?: string;
  fbc?: string;
  gclid?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  landingPath?: string;
  eventId?: string;
}

export interface LeadSubmissionPayload {
  name: string;
  phone: string;
  email?: string;
  postalCode: string;
  preferredDate?: string;
  hasPets?: boolean;
  notes?: string;
  caslSmsConsent: boolean;
  honeypot?: string;
  quoteInput: QuoteInput;
  snapPhotos?: SnapPhotoAttachment[];
  attribution?: AttributionData;
}

export interface LeadSubmissionResult {
  ok: boolean;
  leadId: string;
  finalPreTaxCad: number;
  areaName: string;
  smsPrefillHref: string;
  telegramDispatched: boolean;
  capiDispatched: boolean;
  mode: 'live' | 'demo';
  error?: string;
}

export interface HotspotItem {
  id: string;
  label: string;
  xPct: number;
  yPct: number;
  detail: string;
  competitorNote: string;
  levelupStandard: string;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface PageSeoConfig {
  title: string;
  description: string;
  canonicalPath: string;
  noindex?: boolean;
  ogImage?: string;
  preloadHeroImage?: string;
  serviceSchema?: {
    name: string;
    description: string;
    lowPriceCad: number;
    highPriceCad: number;
  };
  faqs?: FaqItem[];
  breadcrumbs?: Array<{ name: string; path: string }>;
}

export interface AreaHubData {
  slug: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  fsaCodes: string[];
  neighborhoods: string[];
  housingProfile: string;
  parkingAndAccessNotes: string;
  localPainPoints: string[];
  popularPackage: PackageServiceId;
  sampleQuotes: Array<{ label: string; priceCad: number; includes: string }>;
  faqs: FaqItem[];
}

export interface GuideArticle {
  slug: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  publishedDate: string;
  readTimeMinutes: number;
  category: string;
  heroImage: string;
  summary: string;
  surfaceSafetyWarning: string;
  sections: Array<{ heading: string; paragraphs: string[]; bullets?: string[] }>;
  faqs: FaqItem[];
}
