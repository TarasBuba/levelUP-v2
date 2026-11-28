import { expect, test } from '@playwright/test';

function buildMockCalendarPayload() {
  const days = [];
  for (let i = 1; i <= 45; i += 1) {
    const dt = new Date(Date.UTC(2026, 11, i, 18, 0, 0));
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    const date = `${y}-${m}-${d}`;
    const morningState = i === 1 ? 'booked' : 'available';
    const afternoonState = 'available';
    const availableWindows = (morningState === 'available' ? 1 : 0) + 1;
    days.push({
      date,
      dayLabel: `Dec ${Number(d)}`,
      weekdayShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()],
      isWeekend: dt.getUTCDay() === 0 || dt.getUTCDay() === 6,
      morning: {
        window: 'morning',
        label: 'Morning',
        timeRange: '8:30 AM – 12:30 PM',
        state: morningState,
      },
      afternoon: {
        window: 'afternoon',
        label: 'Afternoon',
        timeRange: '1:30 PM – 5:30 PM',
        state: afternoonState,
      },
      availableWindows,
      fullDayAvailable: morningState === 'available' && afternoonState === 'available',
      statusSummary: availableWindows === 2 ? 'available' : 'one_left',
    });
  }
  return {
    timezone: 'America/Edmonton',
    generatedAt: '2026-11-28T18:00:00.000Z',
    storageBackend: 'memory',
    weeklyOpenSlots: 13,
    days,
  };
}

test.describe('LevelUp Cleaning Edmonton — Production E2E Verification', () => {
  test('Homepage Hero Instant Postal Bar, Live Booking Calendar (Morning/Afternoon vs Full-Day), 409 conflict & 200 submit', async ({
    page,
  }) => {
    const mockSchedule = buildMockCalendarPayload();
    let leadPostCalls = 0;

    await page.route('**/api/calendar', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(mockSchedule),
      });
    });

    await page.route('**/api/lead', async (route) => {
      if (route.request().method() === 'POST') {
        leadPostCalls += 1;
        const body = route.request().postDataJSON();
        if (leadPostCalls === 1) {
          await route.fulfill({
            status: 409,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({
              ok: false,
              leadId: '',
              finalPreTaxCad: 345,
              areaName: 'Windermere, Keswick, Ambleside & Heritage Valley',
              smsPrefillHref: 'sms:+17807101503',
              telegramDispatched: false,
              capiDispatched: false,
              slotReserved: false,
              mode: 'live',
              error: 'That time window was just booked. Please pick another open slot.',
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            ok: true,
            leadId: 'LU-CAL2026',
            finalPreTaxCad: 345,
            areaName: 'Windermere, Keswick, Ambleside & Heritage Valley',
            smsPrefillHref: `sms:+17807101503?&body=${encodeURIComponent(
              `Hi LevelUp Cleaning! I'm ${body.name} booking ${body.preferredSlot?.date}.`,
            )}`,
            telegramDispatched: true,
            capiDispatched: true,
            slotReserved: true,
            mode: 'live',
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/');

    const heroForm = page.locator('[data-hero-postal-form]');
    await heroForm.locator('[data-hero-postal]').fill('T6W');
    await heroForm.getByRole('button', { name: /See Price & Open Dates/i }).click();

    const calc = page.locator('[data-calculator-root]');
    await expect(calc.locator('[data-postal-input]')).toHaveValue('T6W');
    await expect(calc.locator('[data-postal-badge]')).toContainText('Windermere');
    await expect(calc.locator('[data-postal-badge]')).toContainText('$0 Travel');

    const cal = calc.locator('[data-booking-calendar]');
    const openDayTwo = cal.locator('[data-cal-day="2026-12-02"]');
    await expect(openDayTwo).toBeEnabled();
    await openDayTwo.click();

    await expect(cal.locator('[data-cal-window="morning"]')).toBeVisible();
    await expect(cal.locator('[data-cal-window="afternoon"]')).toBeVisible();
    await cal.locator('[data-cal-window="morning"]').click();
    await expect(cal.locator('[data-selected-slot-summary]')).toContainText('Morning');
    await expect(calc.locator('[data-quote-slot-pill]')).toBeVisible();

    await calc.locator('[data-bed-btn="3"]').click();
    await expect(cal.locator('[data-cal-scope-note]')).toContainText('Full-Day team block');
    const fullDayBtn = cal.locator('[data-cal-window="full_day"]');
    await expect(fullDayBtn).toBeVisible();
    await fullDayBtn.click();
    await expect(cal.locator('[data-selected-slot-summary]')).toContainText('Full Day Reset');

    await calc.locator('[data-name-input]').fill('Jordan Taylor');
    await calc.locator('[data-phone-input]').fill('(780) 710-1503');
    await calc.locator('[data-casl-checkbox]').check();

    await calc.locator('[data-submit-btn]').click();
    expect(leadPostCalls).toBe(1);
    await expect(calc.locator('[data-form-error]')).toBeVisible();
    await expect(calc.locator('[data-form-error]')).toContainText('just booked');

    await cal.locator('[data-cal-day="2026-12-03"]').click();
    await cal.locator('[data-cal-window="full_day"]').click();
    await calc.locator('[data-submit-btn]').click();

    expect(leadPostCalls).toBe(2);
    await expect(calc.locator('[data-form-error]')).toBeHidden();
    await expect(calc.locator('[data-form-success]')).toBeVisible();
    await expect(calc.locator('[data-success-detail]')).toContainText('LU-CAL2026');
    await expect(calc.locator('[data-success-sms]')).toHaveAttribute(
      'href',
      /^sms:\+17807101503\?&body=/,
    );
  });

  test('Calculator Move-Out FREE $135 bundle, Hourly $48/hr, and CASL checkbox block on /', async ({
    page,
  }) => {
    let leadPostCalls = 0;

    await page.route('**/api/lead', async (route) => {
      if (route.request().method() === 'POST') {
        leadPostCalls += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            ok: true,
            leadId: 'LU-E2E98765',
            finalPreTaxCad: 167,
            areaName: 'Windermere',
            smsPrefillHref: 'sms:+17807101503?&body=Hi',
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
    await calc.locator('[data-postal-input]').fill('T6W');
    await expect(calc.locator('[data-postal-badge]')).toContainText('$0 Travel');

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

    await calc.locator('[data-mode-btn="hourly"]').click();
    await expect(calc.locator('[data-hourly-panel]')).toBeVisible();
    await expect(calc.locator('[data-hourly-panel]')).toContainText('$48/hr');
    await expect(calc.locator('[data-line-service-label]')).toContainText('($48/hr)');
    await expect(calc.locator('[data-line-base-price]')).toHaveText('$192');

    await calc.locator('[data-name-input]').fill('Jordan Taylor');
    await calc.locator('[data-phone-input]').fill('(780) 710-1503');
    await expect(calc.locator('[data-casl-checkbox]')).not.toBeChecked();

    await calc.locator('[data-submit-btn]').click();
    expect(leadPostCalls).toBe(0);
    await expect(calc.locator('[data-form-error]')).toBeVisible();
    await expect(calc.locator('[data-form-error]')).toContainText('CASL SMS consent is required');
    await expect(calc.locator('[data-form-success]')).toBeHidden();

    await calc.locator('[data-casl-checkbox]').check();
    await calc.locator('[data-submit-btn]').click();
    expect(leadPostCalls).toBe(1);
    await expect(calc.locator('[data-form-success]')).toBeVisible();
  });

  test('Room X-Ray & Furry Supervisors lazy .mp4 facade on /', async ({ page }) => {
    const mp4Requests: string[] = [];
    page.on('request', (req) => {
      if (req.url().endsWith('.mp4')) {
        mp4Requests.push(req.url());
      }
    });

    await page.goto('/');

    const xray = page.locator('[data-xray-widget]');
    await expect(xray).toBeVisible();

    const secondKitchenPin = xray.locator('[data-xray-pin="kitchen"]').nth(1);
    const kLabel = await secondKitchenPin.getAttribute('data-spot-label');
    await secondKitchenPin.click();
    await expect(xray.locator('[data-inspector-index]')).toHaveText('02');
    await expect(xray.locator('[data-inspector-label]')).toHaveText(kLabel!);

    const bathTab = xray.locator('[data-xray-room-btn="bathroom"]');
    await bathTab.click();
    await expect(bathTab).toHaveAttribute('aria-selected', 'true');
    const secondBathPin = xray.locator('[data-xray-pin="bathroom"]').nth(1);
    const bLabel = await secondBathPin.getAttribute('data-spot-label');
    await secondBathPin.click();
    await expect(xray.locator('[data-inspector-label]')).toHaveText(bLabel!);

    const firstFacade = page.locator('[data-video-facade]').first();
    await firstFacade.scrollIntoViewIfNeeded();
    const video = firstFacade.locator('[data-facade-video]');
    const poster = firstFacade.locator('[data-facade-poster]');
    const playBtn = firstFacade.locator('[data-facade-play]');
    const expectedMp4 = await firstFacade.getAttribute('data-mp4-src');

    await expect(video).toHaveAttribute('preload', 'none');
    await expect(video).toBeHidden();
    expect(await video.getAttribute('src')).toBeNull();
    await expect(poster).toBeVisible();
    expect(mp4Requests).toHaveLength(0);

    await playBtn.click();
    await expect(poster).toBeHidden();
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('src', expectedMp4!);
  });

  test('Ad funnel /lp/move-out?promo=50 and ?promo=100: dynamic headline sync, noindex meta, and zero nav exit links', async ({
    page,
  }) => {
    await page.goto('/lp/move-out?promo=50');

    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/i);
    await expect(page.locator('h1[data-promo-template]')).toContainText('$50 OFF');
    await expect(page.locator('a[data-promo-template]')).toContainText('$50 OFF');
    await expect(page.locator('[data-promo-badge]')).toContainText('$50 OFF');
    await expect(page.locator('nav')).toHaveCount(0);

    const headerLinks50 = await page
      .locator('header a')
      .evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href') || ''));
    for (const href of headerLinks50) {
      expect(href.startsWith('#')).toBe(true);
    }

    await page.goto('/lp/move-out?promo=100');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/i);
    await expect(page.locator('h1[data-promo-template]')).toContainText('$100 OFF');
    await expect(page.locator('a[data-promo-template]')).toContainText('$100 OFF');
    await expect(page.locator('[data-promo-badge]')).toContainText('$100 OFF');
    await expect(page.locator('[data-quote-promo-badge]')).toContainText('$100 OFF');
    await expect(page.locator('nav')).toHaveCount(0);
  });

  test('New /pricing, /checklist, B2BPartnerForm, GiftOrderForm, /admin/calendar, and mobile 390x844 overflow checks', async ({
    page,
  }) => {
    await page.goto('/pricing');
    await expect(
      page.getByRole('heading', { level: 1, name: /Transparent Edmonton House Cleaning Prices/i }),
    ).toBeVisible();
    await expect(page.locator('table').first()).toContainText('$235');
    await expect(page.locator('table').first()).toContainText('$575');
    await expect(page.locator('body')).toContainText('$48/hr');
    const pricingLd = await page.locator('script[type="application/ld+json"]').first().textContent();
    expect(pricingLd).toContain('"OfferCatalog"');

    await page.goto('/checklist');
    await expect(
      page.getByRole('heading', { level: 1, name: /Interactive Edmonton Cleaning Checklist/i }),
    ).toBeVisible();
    const checklistLd = await page
      .locator('script[type="application/ld+json"]')
      .first()
      .textContent();
    expect(checklistLd).toContain('"ItemList"');
    await page.locator('[data-pkg-tab="deep_clean"]').click();
    await expect(page.locator('[data-pkg-tab="deep_clean"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-pkg-panel="deep_clean"]')).toBeVisible();
    await expect(page.locator('[data-pkg-panel="move_out"]')).toBeHidden();

    const capturedLeadBodies: Array<Record<string, unknown>> = [];
    await page.route('**/api/lead', async (route) => {
      capturedLeadBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          ok: true,
          leadId: 'LU-FORM99',
          finalPreTaxCad: 350,
          areaName: 'Edmonton',
          smsPrefillHref: 'sms:+17807101503',
          telegramDispatched: true,
          capiDispatched: true,
          mode: 'live',
        }),
      });
    });

    await page.goto('/airbnb-cleaning-edmonton');
    const b2bForm = page.locator('[data-b2b-form]');
    await b2bForm.scrollIntoViewIfNeeded();
    await b2bForm.locator('[data-b2b-role="realtor"]').click();
    await b2bForm.locator('[data-b2b-props]').fill('5');
    await b2bForm.locator('[data-b2b-name]').fill('Alex Chen');
    await b2bForm.locator('[data-b2b-phone]').fill('(780) 710-1503');
    await b2bForm.locator('[data-b2b-submit]').click();
    await expect(b2bForm.locator('[data-b2b-error]')).toContainText('CASL SMS consent');
    await b2bForm.locator('[data-b2b-casl]').check();
    await b2bForm.locator('[data-b2b-submit]').click();
    await expect(b2bForm.locator('[data-b2b-success]')).toBeVisible();
    expect(capturedLeadBodies.at(-1)?.leadType).toBe('b2b_partner');

    await page.goto('/gift-a-clean');
    const giftForm = page.locator('[data-gift-form]');
    await giftForm.scrollIntoViewIfNeeded();
    await giftForm.locator('[data-gift-preset="350"]').click();
    await giftForm.locator('[data-gift-recipient]').fill('Sarah & Mark');
    await giftForm.locator('[data-gift-name]').fill('Jordan Taylor');
    await giftForm.locator('[data-gift-phone]').fill('(780) 710-1503');
    await giftForm.locator('[data-gift-submit]').click();
    await expect(giftForm.locator('[data-gift-error]')).toContainText('CASL SMS consent');
    await giftForm.locator('[data-gift-casl]').check();
    await giftForm.locator('[data-gift-submit]').click();
    await expect(giftForm.locator('[data-gift-success]')).toBeVisible();
    expect(capturedLeadBodies.at(-1)?.leadType).toBe('gift_certificate');

    const mockSchedule = buildMockCalendarPayload();
    await page.route('**/api/admin-action', async (route) => {
      const body = route.request().postDataJSON();
      if (body.action === 'set_slot') {
        const target = mockSchedule.days.find((d) => d.date === body.date);
        if (target && body.window === 'morning') {
          target.morning.state = body.state;
        }
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ ok: true, schedule: mockSchedule }),
      });
    });

    await page.goto('/admin/calendar');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/i);
    await page.locator('[data-admin-key-input]').fill('test_admin_key');
    await page.locator('[data-admin-unlock-btn]').click();
    await expect(page.locator('[data-admin-board]')).toBeVisible();
    await expect(page.locator('[data-admin-days-list] article')).toHaveCount(14);

    await page.setViewportSize({ width: 390, height: 844 });
    for (const mobileRoute of ['/', '/pricing', '/checklist']) {
      await page.goto(mobileRoute);
      const overflowCheck = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflowCheck.scrollWidth).toBeLessThanOrEqual(overflowCheck.innerWidth);
    }

    await page.goto('/');
    const stickyBar = page.locator('[aria-label="Quick mobile booking actions"]');
    await expect(stickyBar).toBeVisible();
    await expect(stickyBar.locator('[data-sticky-sms]')).toBeVisible();
  });
});
