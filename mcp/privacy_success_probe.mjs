import { chromium } from 'playwright';

const URL = process.env.PROBE_URL || 'http://127.0.0.1:8899/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, locale: 'zh-CN' });
const errors = [];
page.on('pageerror', err => errors.push((err.stack || err.message).split('\n').slice(0, 6).join(' | ')));

// the deployed proxy answers these; the static server does not
await page.route('**/api/osm-ai/status', route => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ ai: false, translate: true, search: false, visual: false, privacy: true })
}));

let uploadBody = null;
await page.route('**/api/osm-ai/privacy/upload', route => {
  uploadBody = route.request().postData();
  route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ changeset: 188909307, url: 'https://www.openstreetmap.org/changeset/188909307', created: 1, modified: 0, deleted: 0 })
  });
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.context && window.context.map, null, { timeout: 90000 });
await page.waitForTimeout(1500);
for (const sel of ['.start-editing', '.splash .button', '.intro .button']) {
  const el = page.locator(sel).first();
  if (await el.count()) { await el.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(600); }
}

await page.evaluate(async () => {
  const context = window.context;
  context.map().centerZoom([0, 0], 19);
  await new Promise(r => setTimeout(r, 700));
  const node = new window.iD.osmNode({ id: 'n-priv', loc: [0, 0], tags: { amenity: 'cafe' } });
  context.perform(window.iD.actionAddEntity(node));
  await new Promise(r => setTimeout(r, 300));
  context.enter(window.iD.modeSave(context));
});
await page.waitForSelector('.privacy-button', { timeout: 25000 });
await page.waitForTimeout(800);

const before = await page.evaluate(() => ({
  hasChanges: window.context.history().hasChanges(),
  changesCount: window.context.history().difference().summary().length,
  mode: window.context.mode().id
}));

await page.locator('.privacy-button').click();
await page.waitForTimeout(2500);

const after = await page.evaluate(() => ({
  mode: window.context.mode().id,
  successPanel: !!document.querySelector('.body.save-success'),
  changesetLink: document.querySelector('.body.save-success a[href*="changeset"]')?.getAttribute('href') || null,
  changesetIdText: document.querySelector('.body.save-success')?.textContent?.match(/188909307/)?.[0] || null,
  commitPanel: !!document.querySelector('.save-section')
}));

await page.waitForTimeout(3000);
const settled = await page.evaluate(() => ({
  hasChanges: window.context.history().hasChanges(),
  changesCount: window.context.history().difference().summary().length
}));

console.log('before upload:', JSON.stringify(before));
console.log('upload body sent:', uploadBody ? JSON.parse(uploadBody).osmChange.slice(0, 120) : null);
console.log('after upload:', JSON.stringify(after, null, 1));
console.log('after flush:', JSON.stringify(settled));
console.log('page errors:', JSON.stringify(errors.slice(0, 4), null, 1));
await browser.close();
