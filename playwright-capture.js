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

  // ── Block popup/modal service scripts from loading at all ─────────────────
  // If Klaviyo/Privy JS never loads, the popup never gets created.
  await page.route('**/*klaviyo*', route => route.abort());
  await page.route('**/*privy*', route => route.abort());
  await page.route('**/*justuno*', route => route.abort());
  await page.route('**/*optinmonster*', route => route.abort());
  await page.route('**/*sumo.com*', route => route.abort());
  await page.route('**/*wisepops*', route => route.abort());
  await page.route('**/*sleeknote*', route => route.abort());
  console.log('Popup service scripts blocked via route interception');

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

  // ── Remove popups, modals, and overlays from DOM BEFORE capture ────────────
  // CSS can't beat inline !important styles. Remove elements entirely from DOM.
  const removedCount = await page.evaluate(() => {
    let removed = 0;

    // 1. Remove popup services, country selectors, cookie banners, and modal elements
    const popupSelectors = [
      '[class*="klaviyo"]', '[id*="klaviyo"]',
      '[class*="privy"]', '[id*="privy"]',
      '[class*="optinmonster"]', '[id*="optinmonster"]',
      '[class*="justuno"]', '[id*="justuno"]',
      'form[class*="klaviyo"]',
      // Country/locale selectors
      '[class*="country-selector"]', '[id*="country-selector"]',
      '[class*="locale-selector"]', '[class*="localization"]',
      '[class*="country-modal"]', '[id*="CountryModal"]',
      // Cookie/consent banners
      '[class*="cookie"]', '[id*="cookie"]',
      '[class*="consent"]', '[id*="consent"]',
      // Generic modal/drawer overlays
      'dialog[open]', '[role="dialog"]',
      '.modal.is-active', '.modal--active', '.modal.active',
      '[class*="drawer"][class*="active"]',
      '[class*="drawer"][class*="open"]',
    ];
    popupSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => { el.remove(); removed++; });
    });

    // 2. Remove fixed-position overlays (popups, modals, drawers, banners)
    document.querySelectorAll('div, section, aside, form, dialog, details').forEach(el => {
      const style = window.getComputedStyle(el);
      const zIndex = parseInt(style.zIndex) || 0;
      if (style.position === 'fixed' && zIndex > 1) {
        // Skip nav bars (usually at the top with small height)
        const rect = el.getBoundingClientRect();
        if (rect.height > 200 || zIndex > 100) {
          el.remove(); removed++;
        }
      }
    });

    // 3. Remove generic popup/modal overlays that use fixed positioning
    document.querySelectorAll('[class*="popup"], [class*="modal-overlay"], [class*="overlay"]').forEach(el => {
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'absolute') {
        const rect = el.getBoundingClientRect();
        // Only remove if it covers most of the viewport (real overlay)
        if (rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5) {
          el.remove(); removed++;
        }
      }
    });

    // 4. Restore body scroll and visibility
    document.body.style.overflow = 'auto';
    document.body.style.visibility = 'visible';
    document.documentElement.style.overflow = 'auto';
    ['klaviyo-prevent-body-scrolling', 'modal-open', 'popup-open', 'no-scroll', 'overflow-hidden'].forEach(c => {
      document.body.classList.remove(c);
    });

    return removed;
  });
  if (removedCount > 0) {
    console.log(`Removed ${removedCount} popup/modal/overlay elements from DOM`);
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
