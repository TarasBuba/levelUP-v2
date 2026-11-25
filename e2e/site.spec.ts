import { expect, test } from '@playwright/test';

test.describe('LevelUp Cleaning Edmonton — Production E2E Verification', () => {
  test('Calculator flow on /: FSA check, Move-Out FREE bundle, Hourly $48/hr, CASL gate, and mocked /api/lead submit', async ({
    page,
  }) => {
    let leadPostCalls = 0;

    await page.route('**/api/lead', async (route) => {
      if (route.request().method() === 'POST') {
        leadPostCalls += 1;
        const body = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            ok: true,
            leadId: 'LU-E2E98765',
            finalPreTaxCad: 167,
            areaName: 'Windermere, Keswick, Ambleside & Heritage Valley',
            smsPrefillHref: `sms:+17807101503?&body=${encodeURIComponent(
              `Hi LevelUp Cleaning! I'm ${body.name} and I'd like to book Hourly Custom Clean in T6W. Estimated quote: $167 CAD + 5% AB GST where applicable.`,
            )}`,
            telegramDispatched: true,
            capiDispatched: true,
            mode: 'live',
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/');

    const calc = page.locator('[data-calculator-root]');
    await expect(calc).toBeVisible();

    // 1. Edmonton FSA check (T6W -> $0 Travel)
    const postalInput = calc.locator('[data-postal-input]');
    await postalInput.fill('T6W');
    await expect(calc.locator('[data-postal-badge]')).toContainText('Windermere');
    await expect(calc.locator('[data-postal-badge]')).toContainText('$0 Travel');

    // 2. Switch service to Deep Reset first, then Move-Out to verify dynamic auto-lock of Inside Oven, Fridge & Cabinets
    await calc.locator('[data-service-btn="deep_clean"]').click();
    await expect(calc.locator('[data-addon-price-pill="inside_oven"]')).toHaveText('+$45');

    await calc.locator('[data-service-btn="move_out"]').click();
    for (const freeAddon of ['inside_oven', 'inside_fridge', 'inside_cabinets']) {
      await expect(calc.locator(`[data-addon-price-pill="${freeAddon}"]`)).toHaveText(
        'Included FREE',
      );
      await expect(calc.locator(`[data-addon-checkbox="${freeAddon}"]`)).toBeChecked();
      await expect(calc.locator(`[data-addon-checkbox="${freeAddon}"]`)).toBeDisabled();
    }
    await expect(calc.locator('[data-moveout-free-banner]')).toBeVisible();

    // 3. Switch to Hourly ($48/hr)
    await calc.locator('[data-mode-btn="hourly"]').click();
    await expect(calc.locator('[data-hourly-panel]')).toBeVisible();
    await expect(calc.locator('[data-hourly-panel]')).toContainText('$48/hr');
    await expect(calc.locator('[data-line-service-label]')).toContainText('($48/hr)');
    await expect(calc.locator('[data-line-base-price]')).toHaveText('$192');

    // 4. Fill contact details and verify unchecked CASL checkbox blocks submit
    await calc.locator('[data-name-input]').fill('Jordan Taylor');
    await calc.locator('[data-phone-input]').fill('(780) 710-1503');

    const caslCheckbox = calc.locator('[data-casl-checkbox]');
    await expect(caslCheckbox).not.toBeChecked();

    await calc.locator('[data-submit-btn]').click();
    expect(leadPostCalls).toBe(0);
    await expect(calc.locator('[data-form-error]')).toBeVisible();
    await expect(calc.locator('[data-form-error]')).toContainText('CASL SMS consent is required');
    await expect(calc.locator('[data-form-success]')).toBeHidden();

    // 5. Check CASL consent box, submit cleanly, and assert confirmation + live SMS link
    await caslCheckbox.check();
    await calc.locator('[data-submit-btn]').click();

    expect(leadPostCalls).toBe(1);
    await expect(calc.locator('[data-form-error]')).toBeHidden();
    await expect(calc.locator('[data-form-success]')).toBeVisible();
    await expect(calc.locator('[data-success-detail]')).toContainText('LU-E2E98765');

    const successSms = calc.locator('[data-success-sms]');
    await expect(successSms).toBeVisible();
    await expect(successSms).toHaveAttribute('href', /^sms:\+17807101503\?&body=/);
  });

  test('Room X-Ray on /: Kitchen hotspots update inspector details and Bathroom tab switches pins cleanly', async ({
    page,
  }) => {
    await page.goto('/');

    const xray = page.locator('[data-xray-widget]');
    await expect(xray).toBeVisible();

    const kitchenStage = xray.locator('[data-xray-stage="kitchen"]');
    const bathroomStage = xray.locator('[data-xray-stage="bathroom"]');
    await expect(kitchenStage).toBeVisible();
    await expect(bathroomStage).toBeHidden();

    // Click Kitchen hotspot #2 and verify inspector updates
    const secondKitchenPin = xray.locator('[data-xray-pin="kitchen"]').nth(1);
    const kLabel = await secondKitchenPin.getAttribute('data-spot-label');
    const kDetail = await secondKitchenPin.getAttribute('data-spot-detail');
    expect(kLabel).toBeTruthy();
    expect(kDetail).toBeTruthy();

    await secondKitchenPin.click();
    await expect(xray.locator('[data-inspector-index]')).toHaveText('02');
    await expect(xray.locator('[data-inspector-label]')).toHaveText(kLabel!);
    await expect(xray.locator('[data-inspector-detail]')).toHaveText(kDetail!);

    // Switch to Spa Bathroom tab and verify Bathroom pins update inspector details
    const bathTab = xray.locator('[data-xray-room-btn="bathroom"]');
    await bathTab.click();
    await expect(bathTab).toHaveAttribute('aria-selected', 'true');
    await expect(bathroomStage).toBeVisible();
    await expect(kitchenStage).toBeHidden();

    const secondBathPin = xray.locator('[data-xray-pin="bathroom"]').nth(1);
    const bLabel = await secondBathPin.getAttribute('data-spot-label');
    const bDetail = await secondBathPin.getAttribute('data-spot-detail');
    expect(bLabel).toBeTruthy();
    expect(bDetail).toBeTruthy();

    await secondBathPin.click();
    await expect(xray.locator('[data-inspector-index]')).toHaveText('02');
    await expect(xray.locator('[data-inspector-label]')).toHaveText(bLabel!);
    await expect(xray.locator('[data-inspector-detail]')).toHaveText(bDetail!);
  });

  test('Furry Supervisors facade on /: zero eager MP4 download or autoplay before click, activates cleanly on Play', async ({
    page,
  }) => {
    const mp4Requests: string[] = [];
    page.on('request', (req) => {
      if (req.url().endsWith('.mp4')) {
        mp4Requests.push(req.url());
      }
    });

    await page.goto('/');

    const firstFacade = page.locator('[data-video-facade]').first();
    await firstFacade.scrollIntoViewIfNeeded();
    await expect(firstFacade).toBeVisible();

    const video = firstFacade.locator('[data-facade-video]');
    const poster = firstFacade.locator('[data-facade-poster]');
    const playBtn = firstFacade.locator('[data-facade-play]');
    const expectedMp4 = await firstFacade.getAttribute('data-mp4-src');

    // Before click: preload="none", hidden, no src attribute, zero MP4 network requests
    await expect(video).toHaveAttribute('preload', 'none');
    await expect(video).toBeHidden();
    expect(await video.getAttribute('src')).toBeNull();
    await expect(poster).toBeVisible();
    expect(mp4Requests).toHaveLength(0);

    // Click Play and verify video activates cleanly
    await playBtn.click();
    await expect(poster).toBeHidden();
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('src', expectedMp4!);
  });

  test('Ad funnel /lp/move-out?promo=50 and ?promo=100: dynamic headline sync, noindex meta, and zero header nav exit links', async ({
    page,
  }) => {
    await page.goto('/lp/move-out?promo=50');

    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/i);
    await expect(page.locator('h1[data-promo-template]')).toContainText('$50 OFF');
    await expect(page.locator('a[data-promo-template]')).toContainText('$50 OFF');
    await expect(page.locator('[data-promo-badge]')).toContainText('$50 OFF');

    // Zero <nav> elements and zero header exit links to other pages
    await expect(page.locator('nav')).toHaveCount(0);
    const headerLinks50 = await page
      .locator('header a')
      .evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href') || ''));
    for (const href of headerLinks50) {
      expect(href.startsWith('#')).toBe(true);
    }

    // Navigate to ?promo=100 and assert live $100 OFF sync in headline, CTA, badge, and calculator
    await page.goto('/lp/move-out?promo=100');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/i);
    await expect(page.locator('h1[data-promo-template]')).toContainText('$100 OFF');
    await expect(page.locator('a[data-promo-template]')).toContainText('$100 OFF');
    await expect(page.locator('[data-promo-badge]')).toContainText('$100 OFF');
    await expect(page.locator('[data-quote-promo-badge]')).toContainText('$100 OFF');
    await expect(page.locator('nav')).toHaveCount(0);
  });

  test('Mobile 390x844 viewport on /: StickyMobileBar visible and zero horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    const stickyBar = page.locator('[aria-label="Quick mobile booking actions"]');
    await expect(stickyBar).toBeVisible();
    await expect(stickyBar.locator('[data-sticky-sms]')).toBeVisible();
    await expect(stickyBar.getByRole('link', { name: /Instant Price/i })).toBeVisible();

    const overflowCheck = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(overflowCheck.scrollWidth).toBeLessThanOrEqual(overflowCheck.innerWidth);
  });
});
