import { describe, expect, it } from 'vitest';
import { buildSmsPrefillHref, calculateQuote } from '../src/lib/pricing';
import type { Frequency, ServiceId } from '../src/types/contracts';

describe('pricing.ts — Hybrid flat-rate & hourly quote engine', () => {
  it('computes flat-rate packages across 1–5 bedrooms, extra bathrooms, and clamped inputs', () => {
    const regular1 = calculateQuote({
      mode: 'flat_rate',
      service: 'regular',
      bedrooms: 1,
      bathrooms: 1,
    });
    expect(regular1.basePriceCad).toBe(130);
    expect(regular1.extraBathroomFeeCad).toBe(0);
    expect(regular1.subtotalBeforeDiscountsCad).toBe(130);
    expect(regular1.promo.discountCad).toBe(25);
    expect(regular1.finalPreTaxCad).toBe(105);
    expect(regular1.estimatedGstCad).toBe(5.25);
    expect(regular1.competitorMedianCad).toBe(145);
    expect(regular1.competitorSavingsCad).toBe(40);

    const deep4 = calculateQuote({
      mode: 'flat_rate',
      service: 'deep_clean',
      bedrooms: 4,
      bathrooms: 3,
      postalCode: 'T8L',
    });
    expect(deep4.basePriceCad).toBe(420);
    expect(deep4.extraBathroomFeeCad).toBe(50);
    expect(deep4.travelFeeCad).toBe(15);
    expect(deep4.subtotalBeforeDiscountsCad).toBe(485);
    expect(deep4.promo.discountCad).toBe(75);
    expect(deep4.finalPreTaxCad).toBe(410);
    expect(deep4.estimatedGstCad).toBe(20.5);

    const clampedLow = calculateQuote({
      mode: 'flat_rate',
      service: 'unknown_pkg' as ServiceId,
      bedrooms: -3,
      bathrooms: 0,
      frequency: 'unknown_freq' as Frequency,
    });
    expect(clampedLow.service).toBe('regular');
    expect(clampedLow.basePriceCad).toBe(130);
    expect(clampedLow.extraBathroomFeeCad).toBe(0);
    expect(clampedLow.frequencyDiscountPct).toBe(0);

    const clampedHigh = calculateQuote({
      mode: 'flat_rate',
      service: 'move_out',
      bedrooms: 12,
      bathrooms: 9,
      postalCode: 'T2P',
    });
    expect(clampedHigh.basePriceCad).toBe(575);
    expect(clampedHigh.extraBathroomFeeCad).toBe(100);
    expect(clampedHigh.travelFeeCad).toBe(0);
  });

  it('auto-includes Inside Oven, Fridge, and Cabinets FREE ($135 value) on Move-Out without double charging', () => {
    const omitted = calculateQuote({
      mode: 'flat_rate',
      service: 'move_out',
      bedrooms: 2,
      bathrooms: 2,
    });
    expect(omitted.includedFreeSavingsCad).toBe(135);
    expect(omitted.addonsTotalCad).toBe(0);
    expect(omitted.addonsDetail).toHaveLength(3);
    expect(omitted.addonsDetail.every((a) => a.includedFree && a.chargedPriceCad === 0)).toBe(true);

    const explicitWithWindows = calculateQuote({
      mode: 'flat_rate',
      service: 'move_out',
      bedrooms: 2,
      bathrooms: 2,
      addons: [
        'inside_oven',
        'inside_fridge',
        'inside_cabinets',
        'interior_windows',
        'inside_oven',
        'not_an_addon' as never,
      ],
    });
    expect(explicitWithWindows.includedFreeSavingsCad).toBe(135);
    expect(explicitWithWindows.addonsTotalCad).toBe(50);
    expect(explicitWithWindows.addonsDetail).toHaveLength(4);

    const moveOutWeekly = calculateQuote({
      mode: 'flat_rate',
      service: 'move_out',
      bedrooms: 2,
      bathrooms: 1,
      frequency: 'weekly',
    });
    expect(moveOutWeekly.frequencyDiscountPct).toBe(0);
    expect(moveOutWeekly.frequencyDiscountCad).toBe(0);
  });

  it('computes hourly mode ($48/hr, clamped 3..10h and 1..3 cleaners) and Airbnb competitorMedianCad fallback', () => {
    const hourlyDefault = calculateQuote({
      mode: 'hourly',
      service: 'hourly',
      hours: 1,
      cleaners: 0,
    });
    expect(hourlyDefault.mode).toBe('hourly');
    expect(hourlyDefault.basePriceCad).toBe(144);
    expect(hourlyDefault.competitorMedianCad).toBe(150);

    const hourlyMax = calculateQuote({
      mode: 'flat_rate',
      service: 'hourly',
      hours: 25,
      cleaners: 8,
      frequency: 'biweekly',
    });
    expect(hourlyMax.mode).toBe('hourly');
    expect(hourlyMax.basePriceCad).toBe(1440);
    expect(hourlyMax.frequencyDiscountPct).toBe(10);
    expect(hourlyMax.frequencyDiscountCad).toBe(144);
    expect(hourlyMax.competitorMedianCad).toBe(1500);

    const airbnb2 = calculateQuote({
      mode: 'flat_rate',
      service: 'airbnb',
      bedrooms: 2,
      bathrooms: 1,
      addons: ['heavy_pet_hair', 'basement_suite'],
    });
    expect(airbnb2.basePriceCad).toBe(160);
    expect(airbnb2.addonsTotalCad).toBe(100);
    expect(airbnb2.competitorMedianCad).toBe(189);
    expect(airbnb2.competitorSavingsCad).toBe(0);
  });

  it('applies recurring discounts (weekly 15%, biweekly 10%, monthly 5%) and enforces $95 minimum floor', () => {
    const baseInput = {
      mode: 'flat_rate' as const,
      service: 'regular' as const,
      bedrooms: 3,
      bathrooms: 1,
    };

    const weekly = calculateQuote({ ...baseInput, frequency: 'weekly' });
    expect(weekly.frequencyDiscountPct).toBe(15);
    expect(weekly.frequencyDiscountCad).toBe(32);

    const biweekly = calculateQuote({ ...baseInput, frequency: 'biweekly' });
    expect(biweekly.frequencyDiscountPct).toBe(10);
    expect(biweekly.frequencyDiscountCad).toBe(22);

    const monthly = calculateQuote({ ...baseInput, frequency: 'monthly' });
    expect(monthly.frequencyDiscountPct).toBe(5);
    expect(monthly.frequencyDiscountCad).toBe(11);

    const floorClamped = calculateQuote({
      mode: 'flat_rate',
      service: 'airbnb',
      bedrooms: 1,
      bathrooms: 1,
      frequency: 'weekly',
      promoQuery: '25',
    });
    expect(floorClamped.subtotalBeforeDiscountsCad).toBe(120);
    expect(floorClamped.frequencyDiscountCad).toBe(18);
    expect(floorClamped.promo.discountCad).toBe(7);
    expect(floorClamped.finalPreTaxCad).toBe(95);
    expect(floorClamped.estimatedGstCad).toBe(4.75);
  });

  it('builds 1-tap pre-filled SMS href with and without optional customer/postal/promo details', () => {
    const quote = calculateQuote({
      mode: 'flat_rate',
      service: 'move_out',
      bedrooms: 2,
      bathrooms: 2,
      postalCode: 'T6W',
      promoQuery: '50',
    });

    const fullHref = buildSmsPrefillHref(quote, 't6w', 'Jordan Taylor');
    expect(fullHref.startsWith('sms:+17807101503?&body=')).toBe(true);
    const decodedFull = decodeURIComponent(fullHref.split('body=')[1]);
    expect(decodedFull).toContain("I'm Jordan Taylor");
    expect(decodedFull).toContain('in T6W');
    expect(decodedFull).toContain('+ 5% AB GST where applicable');
    expect(decodedFull).toContain('(includes $50 promo)');

    const noPromoQuote = {
      ...quote,
      promo: { ...quote.promo, discountCad: 0 },
    };
    const minimalHref = buildSmsPrefillHref(noPromoQuote);
    const decodedMinimal = decodeURIComponent(minimalHref.split('body=')[1]);
    expect(decodedMinimal).toContain("Hi LevelUp Cleaning! I'd like to book Move-Out / Move-In Inspection Clean.");
    expect(decodedMinimal).not.toContain('includes $');
  });
});
