import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const logs = [];
const errors = [];

page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
page.on('pageerror', (error) => errors.push(error.stack || error.message));
page.on('requestfailed', (request) => {
  logs.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`);
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);

const state = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  iD: typeof globalThis.iD,
  context: typeof globalThis.context,
  body: document.body.innerText.slice(0, 500),
  html: document.documentElement.outerHTML.slice(0, 500)
}));

console.log(JSON.stringify({ state, logs, errors }, null, 2));
await browser.close();
