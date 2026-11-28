import type { APIRoute } from 'astro';
import strategy from '../data/strategy.json';
import { INDEXABLE_ROUTES, SITE_ORIGIN, buildCanonicalUrl } from '../lib/seo';

function formatBedroomBand(baseByBedrooms: Record<string, number>): string {
  return Object.entries(baseByBedrooms)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([beds, price]) => `${beds}bd $${price}`)
    .join(' | ');
}

export function renderLlmsTxt(): string {
  const { pricing, promoEngine, fsaDirectory } = strategy;
  const pkgs = pricing.packages;

  const zeroTravelFsas: string[] = [];
  const ringTravelFsas: string[] = [];

  for (const [fsa, info] of Object.entries(fsaDirectory)) {
    if (info.travelFeeCad === 0) {
      zeroTravelFsas.push(fsa);
    } else {
      ringTravelFsas.push(`${fsa} (${info.municipality})`);
    }
  }

  const addonSummary = Object.values(pricing.addons)
    .map((addon) => `${addon.label}: +$${addon.priceCad} CAD`)
    .join('; ');

  const canonicalLines = INDEXABLE_ROUTES.map(
    (route) => `- ${buildCanonicalUrl(route)}`,
  ).join('\n');

  return [
    '# LevelUp Cleaning — Edmonton & Capital Region Eco Home & Move-Out Cleaning',
    '',
    '> LevelUp Cleaning (LevelUp Cleaning Services Ltd., EST. 2024 • EDMONTON, AB) provides transparent flat-rate and hourly residential, move-out/move-in inspection, 50-point deep reset, and short-term rental cleaning across Greater Edmonton, Alberta, Canada using 100% pet-safe and kid-safe botanical formulas.',
    '',
    '## Canonical Business & Contact Facts',
    `- Brand Name: LevelUp Cleaning (Legal Name: LevelUp Cleaning Services Ltd.)`,
    `- Founded: 2024 in Edmonton, Alberta, Canada`,
    `- Website: ${SITE_ORIGIN}`,
    `- Phone & SMS: +1 (780) 710-1503 (tel:+17807101503 / sms:+17807101503)`,
    `- Email: hello@levelupcleaning.ca`,
    `- Instagram: @levelupcleaning.yeg (https://www.instagram.com/levelupcleaning.yeg/)`,
    `- Languages Spoken: Canadian English & Ukrainian (en-CA, uk)`,
    `- Currency & Tax Rule: All headline prices are pre-tax CAD (${pricing.taxDisplayNote}). Minimum order floor: $${pricing.minimumFloorCad} CAD pre-tax.`,
    '',
    '## Transparent Edmonton Pricing Bands ($120–$575 Pre-Tax CAD)',
    `- Full Transparent Pricing Guide: ${buildCanonicalUrl('/pricing')} — complete 1–5 bedroom flat-rate tables, hourly pricing, recurring discounts, Move-Out $135 appliance bundle savings, travel zones, and Edmonton market benchmarks.`,
    `- ${pkgs.airbnb.title}: $120–$330 CAD pre-tax (${formatBedroomBand(pkgs.airbnb.baseByBedrooms)}) ${pricing.taxDisplayNote}.`,
    `- ${pkgs.regular.title}: $130–$325 CAD pre-tax (${formatBedroomBand(pkgs.regular.baseByBedrooms)}) ${pricing.taxDisplayNote}. Recurring loyalty discounts: 15% OFF Weekly, 10% OFF Bi-Weekly, 5% OFF Monthly.`,
    `- ${pkgs.deep_clean.title}: $210–$495 CAD pre-tax (${formatBedroomBand(pkgs.deep_clean.baseByBedrooms)}) ${pricing.taxDisplayNote}.`,
    `- ${pkgs.move_out.title}: $235–$575 CAD pre-tax (${formatBedroomBand(pkgs.move_out.baseByBedrooms)}) ${pricing.taxDisplayNote}. Includes Inside Oven ($45), Inside Fridge ($45), and Inside Cabinets ($45) FREE ($135 bundle value included at $0 extra) plus an itemized Alberta RTA landlord inspection receipt.`,
    `- Extra Bathrooms (Flat-Rate Packages): +$${pricing.extraBathroomFeeCad} CAD per bathroom beyond the first.`,
    `- Hourly Custom Clean Option: $${pricing.hourly.ratePerCleanerCad}/hr per cleaner (${pricing.hourly.minHours}–${pricing.hourly.maxHours} hours, ${pricing.hourly.minCleaners}–${pricing.hourly.maxCleaners} cleaners) pre-tax CAD (${pricing.taxDisplayNote}) — below the $${pricing.edmontonMarketBenchmarks.medianHourlyCad}/hr Greater Edmonton median across ${pricing.edmontonMarketBenchmarks.companiesSurveyed} surveyed local companies (${pricing.edmontonMarketBenchmarks.dataPoints} pricing records).`,
    `- Optional A-La-Carte Add-Ons: ${addonSummary}.`,
    `- Tiered First-Clean Savings: ${promoEngine.tiers.map((t) => `${t.badge} (orders $${t.minSubtotalCad}+ CAD)`).join('; ')}; seasonal preset holiday50: $50 OFF December Holiday Reset (orders $220+ CAD).`,
    '',
    '## Interactive 50-Point Checklists & Real-Time Edmonton Booking Calendar',
    `- Interactive Checklists Hub: ${buildCanonicalUrl('/checklist')} — room-by-room verification points for Move-Out Inspection, 50-Point Deep Reset, Recurring Maintenance, and Airbnb Turnover, plus interactive Room X-Ray detail map and sample Alberta RTA Landlord Receipt.`,
    '- Real-Time 2-Window Edmonton Calendar (America/Edmonton): Customers view live 45-day availability and reserve Morning 8:30 AM–12:30 PM or Afternoon 1:30 PM–5:30 PM windows directly in the instant quote calculator.',
    '- Full Day Team Block: Larger resets (3+ bedroom Move-Out or Deep Clean packages, or 6+ hour custom hourly bookings) reserve a dedicated Full Day window (8:30 AM–4:30 PM) when both Morning and Afternoon windows are open.',
    '',
    '## B2B Partner Program & Gift Certificates',
    `- B2B Partner Inquiry: ${buildCanonicalUrl('/airbnb-cleaning-edmonton')}#partner-inquiry — dedicated onboarding for Edmonton Realtors, Property Managers, Airbnb Superhosts, and Builders/Developers with priority 11:00 AM–3:00 PM turnover coordination and photo-verified lockbox handoffs.`,
    `- Gift Certificates: ${buildCanonicalUrl('/gift-a-clean')} — online gift certificate ordering starting at $50 CAD pre-tax (popular $150, $250, and $350 CAD tiers or custom amount) with email, SMS, or printable PDF delivery and $0 upfront deposit until confirmation.`,
    '',
    '## Greater Edmonton Postal FSAs & Travel Zones',
    `- $0 Travel Fee Core Zone (${zeroTravelFsas.length} FSAs — Edmonton T5* & T6*, St. Albert T8N, Core Sherwood Park T8A & T8H): ${zeroTravelFsas.join(', ')}.`,
    `- $15 CAD Travel Fee Capital Region Ring (${ringTravelFsas.length} FSAs — 25 km metro ring): ${ringTravelFsas.join(', ')}.`,
    '',
    '## Botanical Pet-Safe Policy & Surface-Safety Chemistry Standard',
    '- 100% Pet-Safe & Kid-Safe Botanical Formulas: Plant-derived eucalyptus surfactants, sealed HEPA filtration vacuums, and colour-coded microfibre cloths on every clean — zero chlorine bleach, zero ammonia fumes, and zero eco upcharges.',
    '- Surface-Safety Chemistry Rule: Acidic or DIY descaling agents such as vinegar, citric acid, or baking soda are safe ONLY on sealed ceramic/porcelain tile or chrome mesh; NEVER use vinegar or acids on marble, travertine, natural stone, quartz, hardwood, unsealed grout, or matte-black/brass fixtures; always spot-test an inconspicuous area first.',
    '',
    '## Approved Risk-Reversal & Trust Protocol',
    '- $0 Upfront Deposit: Reserve online or by SMS with $0 down; pay only after completion via Interac e-Transfer or credit card.',
    '- On-Site 50-Point Walkthrough Sign-Off: Inspect room-by-room with your lead specialist before payment, or receive a timestamped SMS Photo-Verified Report for lockbox, concierge, and vacant condo turnovers.',
    '- Official Itemized Move-Out Cleaning Receipt: Formatted for Edmonton landlords, property managers, and Alberta Residential Tenancies Act (RTA) move-out inspections.',
    '- Vetted Local Team: City of Edmonton licensed business with background-checked local specialists.',
    '',
    `## Canonical Indexable Pages (${INDEXABLE_ROUTES.length} Routes)`,
    canonicalLines,
    '',
  ].join('\n');
}

export const GET: APIRoute = () => {
  const body = renderLlmsTxt();

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
