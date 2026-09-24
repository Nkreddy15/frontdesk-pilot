import 'dotenv/config';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.E2E_BASE_URL || 'http://localhost:3000';
if (!process.env.DEV_AUTH_TOKEN)
  throw new Error('Local owner access is required for this synthetic-data E2E test.');
await mkdir('evidence', { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const results = [];
async function check(name, fn) {
  await fn();
  results.push({ name, passed: true });
  console.log('PASS ' + name);
}
try {
  await check('Owner login and dashboard load', async () => {
    await page.goto(base);
    await page.getByLabel('Local owner access code').fill(process.env.DEV_AUTH_TOKEN);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await page.getByRole('heading', { name: 'A clear view of your day.' }).waitFor();
    const scheduleStatus = await page.evaluate(async () => {
      const from = new Date(Date.now() - 86400000).toISOString();
      const to = new Date(Date.now() + 7 * 86400000).toISOString();
      return (await fetch('/api/v1/appointments?' + new URLSearchParams({ from, to }))).status;
    });
    assert.equal(scheduleStatus, 200, 'Owner schedule API must load');
  });
  await page.screenshot({ path: 'evidence/dashboard-desktop.png', fullPage: true });
  await check(
    'Receptionist creates hold, reads details, and confirms a database booking',
    async () => {
      await page.getByRole('button', { name: 'Receptionist lab', exact: true }).click();
      await page.getByRole('button', { name: 'Start simulated call' }).click();
      await page.getByLabel('Caller name').fill('Taylor Demo');
      await page.getByLabel('Callback number').fill('+15085550123');
      await page.getByRole('button', { name: 'Find appointments' }).click();
      const slot = page.locator('.lab-slot-options .button').first();
      await slot.waitFor();
      await slot.click();
      await page.getByRole('button', { name: 'Yes, confirm these details' }).waitFor();
      assert.equal(await page.getByText('Database commit verified', { exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Yes, confirm these details' }).click();
      await page.getByText('Database commit verified', { exact: true }).waitFor();
    },
  );
  await page.screenshot({ path: 'evidence/receptionist-booking.png', fullPage: true });
  await check('Owner race produces a conflict and three fresh alternatives', async () => {
    await page.getByRole('button', { name: 'End & reset simulation' }).click();
    await page.getByRole('button', { name: 'Start simulated call' }).click();
    await page.getByRole('button', { name: 'Find appointments' }).click();
    await page.locator('.race-link').first().click();
    await page.getByText(/That time was just taken/).waitFor();
    assert.equal(await page.locator('.lab-slot-options>div').count(), 3);
  });
  await page.screenshot({ path: 'evidence/owner-ai-conflict.png', fullPage: true });
  await check('Calls, leads, operations, customer history, and settings render', async () => {
    for (const label of ['Calls & leads', 'Operations', 'Customers', 'Settings']) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('heading', { name: label, exact: true }).waitFor();
    }
    await page.getByRole('button', { name: 'Hours & staff', exact: true }).click();
    await page.getByRole('heading', { name: 'Business hours', exact: true }).waitFor();
  });
  await check('Manual owner booking commits through the same API', async () => {
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByRole('button', { name: 'New appointment', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Customer name', { exact: true }).fill('Morgan Demo');
    await dialog.getByLabel('Callback number', { exact: true }).fill('+15085550124');
    // Choose a fresh option from the API; no fabricated availability.
    const fresh = await page.evaluate(async () => {
      const b = await (await fetch('/api/v1/bootstrap')).json();
      const from = new Date(Date.now() + 5 * 86400000).toISOString();
      const s = await (
        await fetch(
          '/api/v1/availability?' +
            new URLSearchParams({
              locationId: b.locations[0].id,
              serviceId: b.services[0].id,
              from,
              limit: '1',
            }),
        )
      ).json();
      return { slot: s.slots[0], zone: b.locations[0].timezone };
    });
    const local = await page.evaluate(({ slot, zone }) => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(slot.startsAt));
      const value = (t) => parts.find((p) => p.type === t).value;
      return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`;
    }, fresh);
    await dialog.getByLabel('Date & time', { exact: true }).fill(local);
    await dialog.getByRole('button', { name: 'Confirm appointment', exact: true }).click();
    await page.getByRole('heading', { name: 'Appointment confirmed', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  });
  await check('Mobile navigation and schedule fit the viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await page.getByRole('heading', { name: 'Schedule', exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  });
  await page.screenshot({ path: 'evidence/dashboard-mobile.png', fullPage: true });
  assert.deepEqual(errors, [], 'Browser errors');
  await writeFile(
    'evidence/e2e-results.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        base,
        results,
        browserErrors: errors,
        liveProvidersExercised: false,
      },
      null,
      2,
    ),
  );
} catch (e) {
  await page.screenshot({ path: 'evidence/e2e-failure.png', fullPage: true });
  await writeFile(
    'evidence/e2e-results.json',
    JSON.stringify(
      { at: new Date().toISOString(), results, error: e.message, browserErrors: errors },
      null,
      2,
    ),
  );
  throw e;
} finally {
  await browser.close();
}
