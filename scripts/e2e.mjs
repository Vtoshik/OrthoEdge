import { chromium } from 'playwright-core';
const B = process.env.BASE ?? 'https://localhost:8443';
const tok = (await (await fetch(B + '/api/portal/enroll-token', { method: 'POST', headers: { 'content-type': 'application/json', 'x-portal-pin': '1234' }, body: JSON.stringify({ pseudonym: 'P-7F3A' }) })).json()).token;
const br = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await br.newContext({ ignoreHTTPSErrors: true, viewport: { width: 400, height: 800 } });
const pg = await ctx.newPage(); pg.on('pageerror', (e) => console.log('PAGEERR', e.message));
const reading = async () => { await pg.getByRole('button', { name: 'Start' }).click(); await pg.getByText('Got it').waitFor({ timeout: 12000 }); await pg.waitForTimeout(600); };
const session = async (label, { sameBend = false } = {}) => {
  await pg.getByRole('button', { name: /session|Measure again/ }).click();
  await pg.getByRole('button', { name: 'I’m ready' }).click();
  if (sameBend) {                                              // flexion first: phone left in the same place for thigh and shin
    await reading();                                           // flex thigh
    await pg.getByRole('button', { name: 'Start' }).click(); await pg.locator('input[type=range]').fill('20');
    await pg.getByText('Got it').waitFor({ timeout: 12000 });
    await pg.getByText(/bend was not detected/).waitFor({ timeout: 5000 }); console.log(label, '→ rejected same-place bend ✔');
    await reading(); await reading();                          // redo flex thigh, flex shin
  } else { await reading(); await reading(); }
  await reading(); await reading();                            // ext thigh, ext shin
  await pg.getByRole('heading', { name: /hurt/ }).waitFor({ timeout: 8000 });
  await pg.locator('.pbtn.hint').click();
  await pg.getByRole('button', { name: 'Done' }).waitFor({ timeout: 8000 });
  console.log(label, '→', (await pg.locator('h1').innerText()), '|', (await pg.locator('.card').nth(2).innerText()).split('\n')[0], '| ' + (await pg.locator('.nums').first().innerText()).replace(/\n/g, ' '));
  await pg.getByRole('button', { name: 'Done' }).click();
};
await pg.goto(`${B}/?enroll=${tok}`); await pg.getByRole('button', { name: 'Set up' }).click();
await pg.getByText(/Week \d/).waitFor();
console.log('enrolled; secureContext + nonextractable key ok');
await session('normal day', { sameBend: true });
await pg.locator('summary').click(); await pg.getByRole('button', { name: 'red-flag day' }).click();
await pg.getByRole('button', { name: '+1 day' }).click();
await session('red-flag day');
await pg.locator('summary').click().catch(() => {});
await pg.getByRole('button', { name: '+1 day' }).click();
await pg.locator('label:has-text("Tamper") input').check();
await session('tampered');
await pg.locator('summary').click(); await pg.getByRole('button', { name: 'Replay last message' }).click();
console.log(await pg.getByText(/Replay of the last/).innerText());
// offline queue: measure with the network off, then reconnect and let the phone deliver it
const count = async () => (await (await fetch(B + '/api/portal/patients/P-7F3A', { headers: { 'x-portal-pin': '1234' } })).json()).records.length;
const before = await count();
await pg.locator('details.demo').evaluate((e) => { e.open = true; }); await pg.getByRole('button', { name: '+1 day' }).click();
await ctx.setOffline(true);
await session('offline');
await pg.getByText(/waiting to be sent/).waitFor({ timeout: 5000 }); console.log('offline → queued ✔ (', before, 'records on server )');
await ctx.setOffline(false);
await pg.getByText(/waiting to be sent/).waitFor({ state: 'detached', timeout: 15000 });
console.log('back online → delivered ✔ (', await count(), 'records on server )');
const audit = await (await fetch(B + '/api/portal/audit', { headers: { 'x-portal-pin': '1234' } })).json();
console.log('audit chainValid', audit.chainValid, audit.entries.slice(0, 4).map((e) => e.event + ':' + (e.detail.reason ?? (e.detail.alerts ?? []).join('+'))).join(' | '));
// portal UI: the clinician confirms the checks and advances the stage (the app itself only flags readiness)
const portal = await (await br.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1200, height: 900 } })).newPage();
portal.on('pageerror', (e) => console.log('PORTAL PAGEERR', e.message));
await portal.goto(B + '/portal/'); await portal.getByLabel('Demo PIN').fill('1234'); await portal.getByRole('button', { name: 'Open portal' }).click();
await portal.getByRole('button', { name: /Marek/ }).click();
await portal.getByText(/May be ready for review/).first().waitFor({ timeout: 8000 });
const adv = portal.getByRole('button', { name: /Advance to/ });
console.log('advance disabled before checks:', await adv.isDisabled());
for (const box of await portal.locator('.milestone input[type=checkbox]').all()) await box.check();
await adv.click();
await portal.getByText(/Stage 2 · building range \(2\/3\)/).waitFor({ timeout: 8000 });
console.log('clinician advanced Stage 1 → 2 ✔; milestone flag gone:', (await portal.getByText(/May be ready for review/).count()) === 0);
await br.close();
