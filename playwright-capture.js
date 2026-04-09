/**
 * playwright-capture.js
 * Renders a URL in headless Chromium and saves the full DOM to a file.
 * Bypasses Cloudflare and JS-gated pages that curl can't handle.
 * Usage: node playwright-capture.js <url> <outputFile>
 *
 * Handles:
 *  - Cloudflare challenges (real browser UA + headers)
 *  - Replo / Shopify page builders (waits for {{template}} vars to resolve)
 *  - Webflow, React, and other SPA frameworks
 *  - Lazy-loaded images (scroll-to-bottom before capture)
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
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    }
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    console.log('networkidle timeout, capturing current state:', e.message);
  }

  // Initial render wait
  await page.waitForTimeout(3000);

  // ── Scroll through entire page to trigger lazy-load ──────────────────────────
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const step = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        totalHeight += step;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 80);
    });
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  // ── Wait for JS framework template variables to resolve ──────────────────────
  // Replo, Webflow, and Shopify page builders use {{variable}} syntax.
  // If still present after initial load, wait up to 15 more seconds.
  const hasTemplateVars = async () => {
    return await page.evaluate(() => {
      const body = document.body ? document.body.innerHTML : '';
      // Check for unresolved {{...}} in img src/alt or any element attribute
      return /\{\{[^}]+\}\}/.test(body);
    });
  };

  let templateAttempts = 0;
  while (await hasTemplateVars() && templateAttempts < 5) {
    templateAttempts++;
    console.log(`Template vars still present (attempt ${templateAttempts}/5), waiting 3s...`);
    await page.waitForTimeout(3000);
    // Re-scroll to trigger any remaining renders
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  if (templateAttempts > 0) {
    const stillHas = await hasTemplateVars();
    console.log(`Template var resolution: ${stillHas ? 'STILL HAS unresolved vars after ' + templateAttempts + ' attempts' : 'RESOLVED'}`);
  }

  // ── Final wait for any remaining async renders ────────────────────────────────
  await page.waitForTimeout(2000);

  const html = await page.content();
  fs.writeFileSync(outputFile, html, 'utf8');

  // Warn if template vars still present in img attributes
  const imgTemplateVars = (html.match(/src=["'][^"']*\{\{[^}]+\}\}[^"']*["']/g) || []).length;
  if (imgTemplateVars > 0) {
    console.warn(`WARNING: ${imgTemplateVars} img tags still have unresolved template vars in src attribute`);
  }

  console.log(`Captured: ${html.length} bytes from ${url} (template attempts: ${templateAttempts})`);

  await browser.close();
  process.exit(0);
})().catch(err => {
  console.error('Playwright capture error:', err.message);
  process.exit(1);
});
