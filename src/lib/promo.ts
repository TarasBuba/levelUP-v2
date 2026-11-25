import strategyData from '../data/strategy.json';
import type { PromoPreset, PromoResolution, PromoTier } from '../types/contracts';

const PROMO_PRESETS: Record<string, PromoPreset> = strategyData.promoEngine.presets;
const PROMO_TIERS: PromoTier[] = [...strategyData.promoEngine.tiers].sort(
  (a, b) => b.minSubtotalCad - a.minSubtotalCad,
);

export type SupportedPromoCode = '25' | '50' | '100' | 'holiday50';

export interface HeadlinePromoPreset extends PromoPreset {
  shortLabel: string;
}

/**
 * Formats a short headline/CTA token string (e.g. "$50 OFF") for `{PROMO}` interpolation.
 */
export function formatShortPromoLabel(discountCad: number): string {
  const cleanAmount = Number.isFinite(discountCad) ? Math.max(0, Math.round(discountCad)) : 0;
  return `$${cleanAmount} OFF`;
}

/**
 * Replaces `{PROMO}` placeholders in landing page headlines and CTAs with "$XX OFF".
 */
export function interpolatePromoToken(template: string, discountCad: number): string {
  return String(template ?? '').replace(/\{PROMO\}/g, formatShortPromoLabel(discountCad));
}

function normalizePromoCode(raw?: string | null): string {
  if (!raw) {
    return '';
  }
  const trimmed = String(raw).trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.startsWith('?') || trimmed.includes('=')) {
    const queryStr = trimmed.startsWith('?') ? trimmed.slice(1) : trimmed;
    const params = new URLSearchParams(queryStr);
    const paramVal = params.get('promo') ?? params.get('offer') ?? '';
    return paramVal.trim().toLowerCase();
  }
  return trimmed.toLowerCase();
}

function lookupPreset(code?: string | null): PromoPreset | undefined {
  const normalized = normalizePromoCode(code);
  if (!normalized) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(PROMO_PRESETS, normalized)
    ? PROMO_PRESETS[normalized]
    : undefined;
}

/**
 * Resolves the active promo discount for a given pre-discount subtotal.
 * Checks URL query `'25' | '50' | '100' | 'holiday50'` (case-insensitive) against
 * `strategy.json -> promoEngine.presets`; if subtotal qualifies (`>= minSubtotalCad`),
 * returns the URL override (`isUrlOverride: true`), otherwise falls back to the highest
 * qualifying tier in `promoEngine.tiers` (`isUrlOverride: false`).
 */
export function resolvePromo(
  subtotalBeforeDiscountsCad: number,
  promoQuery?: string | null,
): PromoResolution {
  const safeSubtotal = Number.isFinite(subtotalBeforeDiscountsCad)
    ? Math.max(0, subtotalBeforeDiscountsCad)
    : 0;

  const preset = lookupPreset(promoQuery);
  if (preset) {
    const minRequired = preset.minSubtotalCad ?? 0;
    if (safeSubtotal >= minRequired) {
      return {
        appliedCode: preset.code,
        discountCad: preset.discountCad,
        badge: preset.badge,
        isUrlOverride: true,
      };
    }
  }

  const qualifyingTier = PROMO_TIERS.find((tier) => safeSubtotal >= tier.minSubtotalCad);
  if (qualifyingTier) {
    return {
      appliedCode: `tier_${qualifyingTier.discountCad}`,
      discountCad: qualifyingTier.discountCad,
      badge: qualifyingTier.badge,
      isUrlOverride: false,
    };
  }

  return {
    appliedCode: 'none',
    discountCad: 0,
    badge: '',
    isUrlOverride: false,
  };
}

/**
 * Resolves preset metadata for SSR and client-side `{PROMO}` display on `/lp/*` funnels.
 */
export function getHeadlinePromo(
  promoQuery?: string | null,
  fallbackCode: string = '25',
): HeadlinePromoPreset {
  const matched =
    lookupPreset(promoQuery) ?? lookupPreset(fallbackCode) ?? PROMO_PRESETS['25'];

  return {
    ...matched,
    shortLabel: formatShortPromoLabel(matched.discountCad),
  };
}
