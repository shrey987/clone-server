/**
 * playwright-capture.js
 * Renders a URL in headless Chromium and saves the full DOM to a file.
 * Bypasses Cloudflare and JS-gated pages that curl can't handle.
 * Usage: node playwright-capture.js <url> <outputFile>
 */

const { chromium } = require('playwright');
const fs = require('fs');

const url = process.argv[2];
const outputFile = process.argv[3];

if (!url || !outputFile) {
  console.error('Usage: node playwright-capture.js <url> <outputFile>');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    // Timeout on networkidle is okay — grab whatever loaded
    console.log('networkidle timeout, capturing current state:', e.message);
  }

  // Extra wait for JS to finish rendering
  await page.waitForTimeout(3000);

  // Scroll to bottom to trigger lazy-load
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.scrollTo(0, 0));

  const html = await page.content();
  fs.writeFileSync(outputFile, html, 'utf8');

  console.log(`Captured: ${html.length} bytes from ${url}`);

  await browser.close();
  process.exit(0);
})().catch(err => {
  console.error('Playwright capture error:', err.message);
  process.exit(1);
});
