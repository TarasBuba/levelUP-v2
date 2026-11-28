export interface LevelUpTrackingConfig {
  metaPixelId?: string;
  googleAdsId?: string;
  googleAdsLeadLabel?: string;
}

declare global {
  interface Window {
    __LEVELUP_TRACKING?: LevelUpTrackingConfig;
    fbq?: (...args: unknown[]) => void;
    gtag?: (...args: unknown[]) => void;
  }
}

const initializedPixels = new Set<string>();
const initializedGoogleTags = new Set<string>();

export function initAdTracking(config?: {
  metaPixelId?: string;
  googleAdsId?: string;
  googleAdsLeadLabel?: string;
}): void {
  if (typeof window === 'undefined') {
    return;
  }

  const merged: LevelUpTrackingConfig = {
    ...(window.__LEVELUP_TRACKING ?? {}),
    ...(config ?? {}),
  };
  window.__LEVELUP_TRACKING = merged;

  const pixelId = merged.metaPixelId?.trim();
  if (pixelId && typeof window.fbq === 'function' && !initializedPixels.has(pixelId)) {
    initializedPixels.add(pixelId);
    window.fbq('init', pixelId);
    window.fbq('track', 'PageView');
  }

  const googleAdsId = merged.googleAdsId?.trim();
  if (googleAdsId && typeof window.gtag === 'function' && !initializedGoogleTags.has(googleAdsId)) {
    initializedGoogleTags.add(googleAdsId);
    window.gtag('config', googleAdsId);
  }
}

export function trackClientViewContent(params: {
  contentName: string;
  contentCategory: string;
  valueCad: number;
  eventId: string;
}): void {
  if (typeof window === 'undefined') {
    return;
  }

  const safeValue = Number.isFinite(params.valueCad) ? Math.max(0, Math.round(params.valueCad * 100) / 100) : 0;

  if (typeof window.fbq === 'function') {
    window.fbq(
      'track',
      'ViewContent',
      {
        content_name: params.contentName,
        content_category: params.contentCategory,
        value: safeValue,
        currency: 'CAD',
      },
      { eventID: params.eventId },
    );
  }

  if (typeof window.gtag === 'function') {
    window.gtag('event', 'view_item', {
      currency: 'CAD',
      value: safeValue,
      items: [
        {
          item_name: params.contentName,
          item_category: params.contentCategory,
        },
      ],
    });
  }
}

export function trackClientLeadConversion(params: {
  leadId: string;
  valueCad: number;
  service: string;
  email?: string;
  phone?: string;
  postalCode?: string;
}): void {
  if (typeof window === 'undefined') {
    return;
  }

  const safeValue = Number.isFinite(params.valueCad) ? Math.max(0, Math.round(params.valueCad * 100) / 100) : 0;
  const config = window.__LEVELUP_TRACKING;

  if (typeof window.fbq === 'function') {
    window.fbq(
      'track',
      'Lead',
      {
        value: safeValue,
        currency: 'CAD',
        content_name: params.service,
        content_category: params.service,
      },
      { eventID: params.leadId },
    );
  }

  if (typeof window.gtag === 'function') {
    const googleAdsId = config?.googleAdsId?.trim();
    const googleAdsLeadLabel = config?.googleAdsLeadLabel?.trim();
    if (googleAdsId && googleAdsLeadLabel) {
      window.gtag('event', 'conversion', {
        send_to: `${googleAdsId}/${googleAdsLeadLabel}`,
        value: safeValue,
        currency: 'CAD',
        transaction_id: params.leadId,
      });
    } else if (googleAdsId) {
      window.gtag('event', 'generate_lead', {
        value: safeValue,
        currency: 'CAD',
        transaction_id: params.leadId,
        service: params.service,
      });
    }
  }
}
