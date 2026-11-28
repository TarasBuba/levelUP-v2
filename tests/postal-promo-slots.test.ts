import { describe, expect, it } from 'vitest';
import { isSupportedFsa, lookupPostalCode } from '../src/lib/postal';
import {
  formatShortPromoLabel,
  getHeadlinePromo,
  interpolatePromoToken,
  resolvePromo,
} from '../src/lib/promo';
import { DEFAULT_WEEKLY_SLOTS, getSlotsStatus, parseSlotsValue } from '../src/lib/slots';
import strategy from '../src/data/strategy.json';

describe('postal.ts — Greater Edmonton FSA & postal code validation', () => {
  const coreZeroFeeFsas = [
    'T5A', 'T5B', 'T5C', 'T5E', 'T5G', 'T5H', 'T5J', 'T5K', 'T5L', 'T5M',
    'T5N', 'T5P', 'T5R', 'T5S', 'T5T', 'T5V', 'T5W', 'T5X', 'T5Y', 'T5Z',
    'T6A', 'T6B', 'T6C', 'T6E', 'T6G', 'T6H', 'T6J', 'T6K', 'T6L', 'T6M',
    'T6N', 'T6P', 'T6R', 'T6S', 'T6T', 'T6V', 'T6W', 'T6X',
    'T8N', 'T8A', 'T8H',
  ];

  const metroRingFsas = [
    'T8B', 'T8C', 'T8E', 'T8G',
    'T7X', 'T7Y', 'T7Z',
    'T9E', 'T4X', 'T8L', 'T9G',
  ];

  it('validates all core Edmonton, St. Albert, and Sherwood Park $0 travel FSAs', () => {
    for (const fsa of coreZeroFeeFsas) {
      expect(isSupportedFsa(fsa)).toBe(true);
      const res = lookupPostalCode(fsa);
      expect(res.valid).toBe(true);
      expect(res.normalizedFsa).toBe(fsa);
      expect(res.travelFeeCad).toBe(0);
      expect(res.message).toContain('$0 travel fee');
    }
  });

  it('validates all Capital Region metro ring $15 travel FSAs', () => {
    for (const fsa of metroRingFsas) {
      expect(isSupportedFsa(fsa)).toBe(true);
      const res = lookupPostalCode(fsa);
      expect(res.valid).toBe(true);
      expect(res.normalizedFsa).toBe(fsa);
      expect(res.travelFeeCad).toBe(15);
      expect(res.message).toContain('+$15 CAD Capital Region travel fee');
    }
  });

  it('matches every FSA in strategy.json fsaDirectory', () => {
    for (const fsa of Object.keys(strategy.fsaDirectory)) {
      expect(isSupportedFsa(fsa)).toBe(true);
    }
  });

  it('normalizes lowercase, spaced, and hyphenated 6-character Canadian postal codes', () => {
    const core = lookupPostalCode('  t6w-1a2 ');
    expect(core.valid).toBe(true);
    expect(core.normalizedFsa).toBe('T6W');
    expect(core.municipality).toBe('Edmonton');
    expect(core.travelFeeCad).toBe(0);

    const stAlbert = lookupPostalCode('t8n 3k7');
    expect(stAlbert.valid).toBe(true);
    expect(stAlbert.normalizedFsa).toBe('T8N');
    expect(stAlbert.municipality).toBe('St. Albert');
    expect(stAlbert.travelFeeCad).toBe(0);

    const sherwood = lookupPostalCode('t8a4b1');
    expect(sherwood.valid).toBe(true);
    expect(sherwood.normalizedFsa).toBe('T8A');
    expect(sherwood.travelFeeCad).toBe(0);

    const ring = lookupPostalCode('t9e-0a1');
    expect(ring.valid).toBe(true);
    expect(ring.normalizedFsa).toBe('T9E');
    expect(ring.municipality).toBe('Leduc');
    expect(ring.travelFeeCad).toBe(15);
  });

  it('handles empty, whitespace, nullish, malformed, and unsupported FSAs', () => {
    expect(isSupportedFsa('')).toBe(false);
    expect(isSupportedFsa(undefined as unknown as string)).toBe(false);
    expect(isSupportedFsa('T6W 1A2')).toBe(false);
    expect(isSupportedFsa('T2P')).toBe(false);
    expect(isSupportedFsa('T6Z')).toBe(false);

    const empty = lookupPostalCode('');
    expect(empty.valid).toBe(false);
    expect(empty.zoneLabel).toBe('Enter Postal Code');

    const nullish = lookupPostalCode(null as unknown as string);
    expect(nullish.valid).toBe(false);
    expect(nullish.zoneLabel).toBe('Enter Postal Code');

    const dashesOnly = lookupPostalCode(' - - ');
    expect(dashesOnly.valid).toBe(false);
    expect(dashesOnly.zoneLabel).toBe('Enter Postal Code');

    for (const bad of ['T5', 'T5K1A', '123456', 'ABCDEF', 'T6W1A29']) {
      const malformed = lookupPostalCode(bad);
      expect(malformed.valid).toBe(false);
      expect(malformed.zoneLabel).toBe('Invalid Postal Format');
    }

    const calgary = lookupPostalCode('T2P 1J9');
    expect(calgary.valid).toBe(false);
    expect(calgary.normalizedFsa).toBe('T2P');
    expect(calgary.zoneLabel).toBe('Outside Standard Zone');
    expect(calgary.message).toContain('+1 (780) 710-1503');

    const unassignedEdmonton = lookupPostalCode('T6Z');
    expect(unassignedEdmonton.valid).toBe(false);
    expect(unassignedEdmonton.normalizedFsa).toBe('T6Z');
    expect(unassignedEdmonton.zoneLabel).toBe('Outside Standard Zone');
  });
});

describe('promo.ts — URL overrides, tiered promos, and token interpolation', () => {
  it('formats short promo labels and interpolates {PROMO} tokens safely', () => {
    expect(formatShortPromoLabel(50)).toBe('$50 OFF');
    expect(formatShortPromoLabel(74.8)).toBe('$75 OFF');
    expect(formatShortPromoLabel(-20)).toBe('$0 OFF');
    expect(formatShortPromoLabel(Number.NaN)).toBe('$0 OFF');
    expect(formatShortPromoLabel(Number.POSITIVE_INFINITY)).toBe('$0 OFF');

    expect(
      interpolatePromoToken('Claim {PROMO} Your Clean — {PROMO} Today', 100),
    ).toBe('Claim $100 OFF Your Clean — $100 OFF Today');
    expect(interpolatePromoToken(null as unknown as string, 25)).toBe('');
  });

  it('resolves URL overrides (25, 50, 100, holiday50) case-insensitively and via ?promo= / ?offer=', () => {
    expect(resolvePromo(150, '25')).toEqual({
      appliedCode: '25',
      discountCad: 25,
      badge: '$25 OFF Your First Clean',
      isUrlOverride: true,
    });

    expect(resolvePromo(250, '?promo=50')).toEqual({
      appliedCode: '50',
      discountCad: 50,
      badge: '$50 OFF Special Offer',
      isUrlOverride: true,
    });

    expect(resolvePromo(310, 'offer=100')).toEqual({
      appliedCode: '100',
      discountCad: 100,
      badge: '$100 OFF Executive / Recurring Bundle',
      isUrlOverride: true,
    });

    expect(resolvePromo(230, '?offer=HOLIDAY50')).toEqual({
      appliedCode: 'holiday50',
      discountCad: 50,
      badge: '$50 OFF December Holiday Reset',
      isUrlOverride: true,
    });
  });

  it('falls back to tiered promos when subtotal is below URL preset minSubtotalCad', () => {
    const fallbackFrom100 = resolvePromo(220, '100');
    expect(fallbackFrom100.isUrlOverride).toBe(false);
    expect(fallbackFrom100.appliedCode).toBe('tier_25');
    expect(fallbackFrom100.discountCad).toBe(25);

    const fallbackFromHoliday = resolvePromo(180, 'holiday50');
    expect(fallbackFromHoliday.isUrlOverride).toBe(false);
    expect(fallbackFromHoliday.appliedCode).toBe('tier_25');

    const fallbackFrom25 = resolvePromo(100, '25');
    expect(fallbackFrom25.isUrlOverride).toBe(false);
    expect(fallbackFrom25.appliedCode).toBe('tier_25');
  });

  it('resolves all default subtotal tiers (0, >= 300, >= 480) and handles NaN/negative/empty queries', () => {
    expect(resolvePromo(0)).toEqual({
      appliedCode: 'tier_25',
      discountCad: 25,
      badge: '$25 OFF First Clean',
      isUrlOverride: false,
    });
    expect(resolvePromo(-100, '   ')).toEqual({
      appliedCode: 'tier_25',
      discountCad: 25,
      badge: '$25 OFF First Clean',
      isUrlOverride: false,
    });
    expect(resolvePromo(Number.NaN, '?utm_source=meta')).toEqual({
      appliedCode: 'tier_25',
      discountCad: 25,
      badge: '$25 OFF First Clean',
      isUrlOverride: false,
    });
    expect(resolvePromo(300, 'unknown_code')).toEqual({
      appliedCode: 'tier_50',
      discountCad: 50,
      badge: '$50 OFF Large Home / Move-Out',
      isUrlOverride: false,
    });
    expect(resolvePromo(480, null)).toEqual({
      appliedCode: 'tier_75',
      discountCad: 75,
      badge: '$75 OFF Full Estate Reset',
      isUrlOverride: false,
    });
  });

  it('resolves getHeadlinePromo with query override, fallback code, and ultimate default', () => {
    const p100 = getHeadlinePromo('?promo=100', '50');
    expect(p100.code).toBe('100');
    expect(p100.shortLabel).toBe('$100 OFF');

    const fallback50 = getHeadlinePromo(null, '50');
    expect(fallback50.code).toBe('50');
    expect(fallback50.shortLabel).toBe('$50 OFF');

    const default25 = getHeadlinePromo(undefined);
    expect(default25.code).toBe('25');
    expect(default25.shortLabel).toBe('$25 OFF');

    const ultimateFallback = getHeadlinePromo('nonexistent', 'also_bad');
    expect(ultimateFallback.code).toBe('25');
    expect(ultimateFallback.shortLabel).toBe('$25 OFF');
  });
});

describe('slots.ts — Weekly open-slot parsing and badge status', () => {
  it('parses numbers, strings, clamping bounds, and fallbacks accurately', () => {
    expect(DEFAULT_WEEKLY_SLOTS).toBe(3);
    expect(parseSlotsValue(5)).toBe(5);
    expect(parseSlotsValue(3.7)).toBe(4);
    expect(parseSlotsValue(-4)).toBe(0);
    expect(parseSlotsValue(99)).toBe(9);
    expect(parseSlotsValue(Number.NaN)).toBe(DEFAULT_WEEKLY_SLOTS);
    expect(parseSlotsValue(Number.POSITIVE_INFINITY)).toBe(DEFAULT_WEEKLY_SLOTS);

    expect(parseSlotsValue('0')).toBe(0);
    expect(parseSlotsValue(' 7 ')).toBe(7);
    expect(parseSlotsValue('-2')).toBe(0);
    expect(parseSlotsValue('18')).toBe(9);
    expect(parseSlotsValue('')).toBe(DEFAULT_WEEKLY_SLOTS);
    expect(parseSlotsValue('   ')).toBe(DEFAULT_WEEKLY_SLOTS);
    expect(parseSlotsValue('sold-out')).toBe(DEFAULT_WEEKLY_SLOTS);

    expect(parseSlotsValue(null)).toBe(DEFAULT_WEEKLY_SLOTS);
    expect(parseSlotsValue(undefined)).toBe(DEFAULT_WEEKLY_SLOTS);
    expect(parseSlotsValue({})).toBe(DEFAULT_WEEKLY_SLOTS);
  });

  it('formats sold-out, single-slot urgent, low-slot urgent, and normal availability labels', () => {
    expect(getSlotsStatus(0)).toEqual({
      slots: 0,
      label: 'Fully booked this week — now booking next week in Edmonton',
      urgent: true,
    });

    expect(getSlotsStatus('1')).toEqual({
      slots: 1,
      label: 'Only 1 open slot left in Edmonton this week',
      urgent: true,
    });

    expect(getSlotsStatus(2)).toEqual({
      slots: 2,
      label: '2 open slots left in Edmonton this week',
      urgent: true,
    });

    expect(getSlotsStatus(undefined)).toEqual({
      slots: 3,
      label: '3 open slots left in Edmonton this week',
      urgent: true,
    });

    expect(getSlotsStatus(6)).toEqual({
      slots: 6,
      label: '6 open slots available in Edmonton this week',
      urgent: false,
    });
  });
});
