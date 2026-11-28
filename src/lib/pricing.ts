import strategyData from '../data/strategy.json';
import type {
  AddonBreakdownItem,
  AddonId,
  Frequency,
  PackageServiceId,
  QuoteBreakdown,
  QuoteInput,
  ServiceId,
} from '../types/contracts';
import { lookupPostalCode } from './postal';
import { resolvePromo } from './promo';

const PRICING = strategyData.pricing;

const VALID_ADDON_IDS: readonly AddonId[] = [
  'inside_oven',
  'inside_fridge',
  'inside_cabinets',
  'interior_windows',
  'wall_spot_wash',
  'heavy_pet_hair',
  'basement_suite',
];

const MOVE_OUT_INCLUDED_ADDONS: readonly AddonId[] = [
  'inside_oven',
  'inside_fridge',
  'inside_cabinets',
];

const HOURLY_FREQUENCY_DISCOUNT_PCT: Record<Frequency, number> = {
  one_time: 0,
  monthly: 5,
  biweekly: 10,
  weekly: 15,
};

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeFrequency(frequency?: Frequency): Frequency {
  if (
    frequency === 'weekly' ||
    frequency === 'biweekly' ||
    frequency === 'monthly' ||
    frequency === 'one_time'
  ) {
    return frequency;
  }
  return 'one_time';
}

function normalizePackageService(service: ServiceId): PackageServiceId {
  if (
    service === 'move_out' ||
    service === 'deep_clean' ||
    service === 'regular' ||
    service === 'airbnb'
  ) {
    return service;
  }
  return 'regular';
}

function buildAddonsBreakdown(
  requestedAddons: AddonId[] | undefined,
  isMoveOutPackage: boolean,
): {
  addonsDetail: AddonBreakdownItem[];
  addonsTotalCad: number;
  includedFreeSavingsCad: number;
} {
  const requestedSet = new Set<AddonId>();
  if (Array.isArray(requestedAddons)) {
    for (const id of requestedAddons) {
      if ((VALID_ADDON_IDS as readonly string[]).includes(id)) {
        requestedSet.add(id);
      }
    }
  }

  const orderedIds: AddonId[] = [];
  if (isMoveOutPackage) {
    for (const freeId of MOVE_OUT_INCLUDED_ADDONS) {
      orderedIds.push(freeId);
    }
  }
  for (const reqId of requestedSet) {
    if (!orderedIds.includes(reqId)) {
      orderedIds.push(reqId);
    }
  }

  const addonsDetail: AddonBreakdownItem[] = orderedIds.map((id) => {
    const cfg = PRICING.addons[id];
    const includedFree = isMoveOutPackage && MOVE_OUT_INCLUDED_ADDONS.includes(id);
    const regularPriceCad = cfg.priceCad;
    const chargedPriceCad = includedFree ? 0 : regularPriceCad;
    return {
      id,
      label: cfg.label,
      regularPriceCad,
      chargedPriceCad,
      includedFree,
    };
  });

  const addonsTotalCad = addonsDetail.reduce((sum, item) => sum + item.chargedPriceCad, 0);
  const includedFreeSavingsCad = addonsDetail.reduce(
    (sum, item) => (item.includedFree ? sum + item.regularPriceCad : sum),
    0,
  );

  return { addonsDetail, addonsTotalCad, includedFreeSavingsCad };
}

export function calculateQuote(input: QuoteInput): QuoteBreakdown {
  const isHourly = input.mode === 'hourly' || input.service === 'hourly';
  const frequency = normalizeFrequency(input.frequency);

  const bedrooms = clampInt(input.bedrooms, 1, 5, 1);
  const bathrooms = clampInt(input.bathrooms, 1, 5, 1);
  const hours = clampInt(
    input.hours,
    PRICING.hourly.minHours,
    PRICING.hourly.maxHours,
    PRICING.hourly.minHours,
  );
  const cleaners = clampInt(
    input.cleaners,
    PRICING.hourly.minCleaners,
    PRICING.hourly.maxCleaners,
    PRICING.hourly.minCleaners,
  );

  let mode: 'flat_rate' | 'hourly';
  let service: ServiceId;
  let serviceTitle: string;
  let basePriceCad: number;
  let extraBathroomFeeCad: number;
  let frequencyDiscountPct: number;
  let competitorMedianCad: number;

  if (isHourly) {
    mode = 'hourly';
    service = 'hourly';
    serviceTitle = 'Hourly Custom Clean';
    basePriceCad = hours * cleaners * PRICING.hourly.ratePerCleanerCad;
    extraBathroomFeeCad = 0;
    frequencyDiscountPct = HOURLY_FREQUENCY_DISCOUNT_PCT[frequency];
    competitorMedianCad = PRICING.edmontonMarketBenchmarks.medianHourlyCad * hours * cleaners;
  } else {
    mode = 'flat_rate';
    const pkgId = normalizePackageService(input.service);
    service = pkgId;
    const pkg = PRICING.packages[pkgId];
    serviceTitle = pkg.title;
    const bedroomKey = String(bedrooms) as '1' | '2' | '3' | '4' | '5';
    basePriceCad = pkg.baseByBedrooms[bedroomKey];
    extraBathroomFeeCad = (bathrooms - 1) * PRICING.extraBathroomFeeCad;
    frequencyDiscountPct = pkg.frequencyDiscountPct[frequency] ?? 0;

    const mediansMap = PRICING.edmontonMarketBenchmarks.mediansCad as Record<
      string,
      Record<string, number> | undefined
    >;
    const serviceMedians = mediansMap[pkgId] ?? PRICING.edmontonMarketBenchmarks.mediansCad.regular;
    const medianBedroomKey = `${bedrooms}bd` as keyof typeof PRICING.edmontonMarketBenchmarks.mediansCad.regular;
    competitorMedianCad =
      serviceMedians[medianBedroomKey] ??
      PRICING.edmontonMarketBenchmarks.mediansCad.regular[medianBedroomKey];
  }

  const isMoveOutPackage = mode === 'flat_rate' && service === 'move_out';
  const { addonsDetail, addonsTotalCad, includedFreeSavingsCad } = buildAddonsBreakdown(
    input.addons,
    isMoveOutPackage,
  );

  const postalResult = input.postalCode ? lookupPostalCode(input.postalCode) : null;
  const travelFeeCad = postalResult && postalResult.valid ? postalResult.travelFeeCad : 0;

  const subtotalBeforeDiscountsCad =
    basePriceCad + extraBathroomFeeCad + addonsTotalCad + travelFeeCad;

  const frequencyDiscountCad = Math.round(
    (subtotalBeforeDiscountsCad * frequencyDiscountPct) / 100,
  );
  const afterFrequencyCad = Math.max(0, subtotalBeforeDiscountsCad - frequencyDiscountCad);

  const rawPromo = resolvePromo(subtotalBeforeDiscountsCad, input.promoQuery);
  const maxAllowedPromoDiscount = Math.max(0, afterFrequencyCad - PRICING.minimumFloorCad);
  const effectivePromoDiscountCad = Math.min(rawPromo.discountCad, maxAllowedPromoDiscount);

  const promo = {
    ...rawPromo,
    discountCad: effectivePromoDiscountCad,
  };

  const finalPreTaxCad = Math.max(
    PRICING.minimumFloorCad,
    afterFrequencyCad - effectivePromoDiscountCad,
  );

  const estimatedGstCad = Math.round(finalPreTaxCad * PRICING.gstRate * 100) / 100;
  const competitorSavingsCad = Math.max(0, competitorMedianCad - finalPreTaxCad);

  return {
    mode,
    service,
    serviceTitle,
    basePriceCad,
    extraBathroomFeeCad,
    addonsTotalCad,
    includedFreeSavingsCad,
    addonsDetail,
    travelFeeCad,
    subtotalBeforeDiscountsCad,
    frequencyDiscountPct,
    frequencyDiscountCad,
    promo,
    finalPreTaxCad,
    estimatedGstCad,
    competitorMedianCad,
    competitorSavingsCad,
  };
}

export function buildSmsPrefillHref(
  quote: QuoteBreakdown,
  postalCode?: string,
  customerName?: string,
): string {
  const cleanName = String(customerName ?? '').trim();
  const cleanPostal = String(postalCode ?? '').trim().toUpperCase();

  const intro = cleanName
    ? `Hi LevelUp Cleaning! I'm ${cleanName} and I'd like to book `
    : `Hi LevelUp Cleaning! I'd like to book `;

  const areaPart = cleanPostal ? ` in ${cleanPostal}` : '';
  const promoPart =
    quote.promo.discountCad > 0 ? ` (includes $${quote.promo.discountCad} promo)` : '';

  const message = `${intro}${quote.serviceTitle}${areaPart}. Estimated quote: $${quote.finalPreTaxCad} CAD + 5% AB GST where applicable${promoPart}.`;

  return `sms:+17807101503?&body=${encodeURIComponent(message)}`;
}
