/**
 * playwright-capture.js v2
 * Bulletproof page capture engine with route-level asset interception.
 *
 * Architecture:
 *   1. Block popup/tracking/analytics scripts via @ghostery/adblocker + manual domain list
 *   2. Intercept all image/font/css/media responses via page.route, save to assets/
 *   3. Wait for full render via MutationObserver DOM quiescence + template var polling
 *   4. Remove overlay DOM nodes (popups, modals, country selectors)
 *   5. Capture page.content(), rewrite all URLs to local assets/ paths
 *
 * Usage: node playwright-capture.js <url> <jobDir>
 *   jobDir must contain an empty assets/ directory
 *   Produces: jobDir/page.html + jobDir/assets/* + jobDir/asset-manifest.json
 */

const { chromium } = require('playwright');
const { PlaywrightBlocker } = require('@ghostery/adblocker-playwright');
const fetch = require('cross-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const url = process.argv[2];
const jobDir = process.argv[3];

if (!url || !jobDir) {
  console.error('Usage: node playwright-capture.js <url> <jobDir>');
  process.exit(1);
}

const assetsDir = path.join(jobDir, 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

// Domains to block entirely (popup services, analytics, chat widgets)
const BLOCK_DOMAINS = [
  // Email capture
  'klaviyo.com', 'a.klaviyo.com', 'static.klaviyocdn.com',
  'privy.com', 'static.privy.com',
  'optinmonster.com', 'app.optinmonster.com', 'api.optinmonster.com',
  'justuno.com', 'app.justuno.com',
  'sumo.com', 'sumo.io', 'sumome.com', 'load.sumo.com',
  'poptin.com', 'wisepops.com', 'getsitecontrol.com', 'sleeknote.com',
  // Cookie consent
  'cdn.cookielaw.org', 'geolocation.onetrust.com', 'optanon.blob.core.windows.net',
  'cdn.cookiebot.com', 'consent.cookiebot.com',
  'usercentrics.eu', 'app.usercentrics.eu',
  // Chat widgets
  'widget.intercom.io', 'js.intercomcdn.com', 'api-iam.intercom.io',
  'js.driftt.com', 'drift.com',
  'widget.crisp.chat', 'client.crisp.chat',
  'static.zdassets.com', 'ekr.zdassets.com',
  'embed.tawk.to',
  'cdn.lr-ingest.io', 'cdn.logrocket.io',
  // Analytics/tracking
  'www.googletagmanager.com', 'www.google-analytics.com', 'analytics.google.com',
  'connect.facebook.net', 'www.facebook.com',
  'static.hotjar.com', 'script.hotjar.com',
  'cdn.heapanalytics.com', 'cdn.segment.com',
  'cdn.amplitude.com', 'api2.amplitude.com',
  'plausible.io', 'cdn.usefathom.com',
  'bat.bing.com', 'snap.licdn.com',
  'sc-static.net', 'sentry.io',
  // Shopify-specific (cart/checkout that 404 on static hosting)
  'monorail-edge.shopifysvc.net',
];

// Asset types worth intercepting
const ASSET_RESOURCE_TYPES = ['image', 'stylesheet', 'font', 'media'];
const ASSET_EXTENSIONS = /\.(jpg|jpeg|png|webp|gif|svg|avif|ico|mp4|webm|mov|woff2?|ttf|otf|eot|css)(\?|$|#)/i;

(async () => {
  // ── Phase 1: Setup ────────────────────────────────────────────────────────
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    }
  });

  const page = await context.newPage();

  // Enable Ghostery adblocker (blocks most popup/tracking scripts automatically)
  try {
    const blocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch);
    await blocker.enableBlockingInPage(page);
    console.log('Ghostery adblocker enabled');
  } catch (e) {
    console.log('Ghostery adblocker failed to load, using manual blocking only:', e.message);
  }

  // Inject init scripts to kill popup globals BEFORE any page JS runs
  await page.addInitScript(() => {
    // Kill email capture / popup globals
    const noop = () => {};
    const noopObj = new Proxy({}, { get: () => noop });
    ['Klaviyo', '_klOnsite', 'KlaviyoSubscribe'].forEach(k => {
      try { Object.defineProperty(window, k, { get: () => noopObj, set: noop, configurable: true }); } catch(e) {}
    });
    ['Privy', 'OptinMonster', 'om_loaded'].forEach(k => {
      try { Object.defineProperty(window, k, { get: () => undefined, set: noop, configurable: true }); } catch(e) {}
    });
    // Kill chat widgets
    ['Intercom', 'drift', '$crisp', 'zE', 'Tawk_API'].forEach(k => {
      try { Object.defineProperty(window, k, { get: () => noop, set: noop, configurable: true }); } catch(e) {}
    });
    // Kill OneTrust / cookie consent
    ['OneTrust', 'OptanonWrapper', 'CookieBot'].forEach(k => {
      try { Object.defineProperty(window, k, { get: () => undefined, set: noop, configurable: true }); } catch(e) {}
    });
    // Set Shopify locale to prevent country selector modal
    window.Shopify = window.Shopify || {};
    window.Shopify.country = 'US';
    window.Shopify.locale = 'en';
    window.Shopify.currency = { active: 'USD', rate: '1.0' };
    // Disable service workers
    if (navigator.serviceWorker) {
      navigator.serviceWorker.getRegistrations().then(r => r.forEach(reg => reg.unregister()));
    }
  });

  // ── Asset interception via page.route ───────────────────────────────────
  const urlMap = new Map(); // original URL string → local assets/ path
  let assetCounter = 0;

  await page.route('**/*', async (route) => {
    const req = route.request();
    const reqUrl = req.url();

    // Block popup/tracking domains
    if (BLOCK_DOMAINS.some(d => reqUrl.includes(d))) {
      return route.abort().catch(() => {});
    }

    const resourceType = req.resourceType();

    // Intercept assets: save to disk and build URL map
    if (ASSET_RESOURCE_TYPES.includes(resourceType) || ASSET_EXTENSIONS.test(reqUrl)) {
      try {
        const response = await route.fetch();
        const buffer = await response.body();

        // Skip tiny responses or HTML error pages
        if (buffer.length < 100 && buffer.toString().includes('<html')) {
          await route.fulfill({ response });
          return;
        }

        // Generate filename from URL - preserve extension, use hash for uniqueness
        const urlObj = new URL(reqUrl);
        let baseName = path.basename(urlObj.pathname).replace(/[^a-zA-Z0-9._-]/g, '_');
        // Ensure extension is preserved even if name is truncated
        const extMatch = baseName.match(/\.([a-zA-Z0-9]{1,5})$/);
        const ext = extMatch ? extMatch[0] : '';
        if (baseName.length > 120) {
          baseName = baseName.slice(0, 120 - ext.length) + ext;
        }
        const hash = crypto.createHash('md5').update(reqUrl).digest('hex').slice(0, 8);
        const fileName = `${hash}-${baseName || 'asset'}`;
        const localPath = path.join(assetsDir, fileName);

        fs.writeFileSync(localPath, buffer);
        const assetRef = `assets/${fileName}`;
        urlMap.set(reqUrl, assetRef);

        // Also map the URL without query string (many HTML refs strip params)
        const noQuery = reqUrl.split('?')[0];
        if (noQuery !== reqUrl && !urlMap.has(noQuery)) {
          urlMap.set(noQuery, assetRef);
        }

        // Map protocol-relative version (//domain.com/path → same asset)
        // HTML often has //cdn.shopify.com/... while browser resolves to https://cdn.shopify.com/...
        if (reqUrl.startsWith('https://')) {
          const protoRelative = reqUrl.replace('https:', '');
          urlMap.set(protoRelative, assetRef);
          const protoRelativeNoQuery = noQuery.replace('https:', '');
          if (!urlMap.has(protoRelativeNoQuery)) {
            urlMap.set(protoRelativeNoQuery, assetRef);
          }
        }

        assetCounter++;
        await route.fulfill({ response, body: buffer });
      } catch (e) {
        // Fetch failed (CORS, timeout, etc.) — let it through
        await route.continue().catch(() => {});
      }
      return;
    }

    // Everything else: pass through
    await route.continue().catch(() => {});
  });

  // ── Phase 2: Navigate + wait for full render ──────────────────────────────
  console.log(`Navigating to ${url}...`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.log('Navigation timeout, capturing current state:', e.message);
  }

  // Initial wait for critical resources
  await page.waitForTimeout(2000);

  // Incremental scroll to trigger ALL lazy-load / IntersectionObserver elements
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

  // MutationObserver: wait for DOM to stabilize (500ms of silence)
  await page.evaluate(() => {
    return new Promise((resolve) => {
      let timeout;
      const maxWait = setTimeout(() => { observer.disconnect(); resolve(); }, 10000);
      const observer = new MutationObserver(() => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          observer.disconnect();
          clearTimeout(maxWait);
          resolve();
        }, 500);
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      // Bootstrap timer in case DOM is already stable
      timeout = setTimeout(() => {
        observer.disconnect();
        clearTimeout(maxWait);
        resolve();
      }, 500);
    });
  });
  console.log('DOM stabilized');

  // Template variable polling (Replo, GemPages, etc.)
  let templateAttempts = 0;
  while (templateAttempts < 5) {
    const hasTemplateVars = await page.evaluate(() => /\{\{[^}]+\}\}/.test(document.body.innerHTML));
    if (!hasTemplateVars) break;
    templateAttempts++;
    console.log(`Template vars present (attempt ${templateAttempts}/5), waiting 3s...`);
    await page.waitForTimeout(3000);
    await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.scrollTo(0, 0); });
  }

  // Remove popup/modal/overlay DOM nodes that survived blocking
  const removedCount = await page.evaluate(() => {
    let removed = 0;
    // Remove by selector
    const popupSelectors = [
      // Email capture
      '[class*="klaviyo"]', '[id*="klaviyo"]',
      '[class*="privy"]', '[id*="privy"]',
      '[class*="optinmonster"]', '[id*="optinmonster"]',
      '[class*="justuno"]', '[id*="justuno"]',
      // Country / locale selectors
      '[class*="country-selector"]', '[id*="country-selector"]',
      '[class*="country-modal"]', '[id*="country-modal"]',
      '[class*="locale-selector"]', '[id*="locale-selector"]',
      // Cookie consent
      '[class*="cookie"]', '[id*="cookie"]',
      '[class*="consent"]', '[id*="consent"]',
      // Modals and dialogs (generic)
      'dialog[open]', 'dialog', '[role="dialog"]',
      '.modal.is-active', '.modal--active', '.modal.active', '.modal.show',
      '[class*="modal"][class*="open"]', '[class*="modal"][class*="active"]', '[class*="modal"][class*="visible"]',
      // Drawers
      '[class*="drawer"][class*="active"]', '[class*="drawer"][class*="open"]',
      // Size guides and fit guides
      '[class*="size-guide"]', '[id*="size-guide"]',
      '[class*="fit-guide"]', '[id*="fit-guide"]',
      '[class*="sizing"]', '[id*="sizing-modal"]',
      // Overlays and backdrops
      '[class*="overlay"][class*="active"]', '[class*="overlay"][class*="visible"]',
      '[class*="backdrop"]',
      // Chat widgets that survived blocking
      '[class*="chat-widget"]', '[id*="chat-widget"]',
      '[class*="tidio"]', '[id*="tidio"]',
      // Subscription/notification popups
      '[class*="popup"][class*="active"]', '[class*="popup"][class*="visible"]', '[class*="popup"][class*="show"]',
      // Shopify-specific
      '[class*="shopify-chat"]', '#shopify-chat',
    ];
    popupSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => { el.remove(); removed++; });
    });
    // Remove fixed/sticky overlays, modals, and high-z-index elements
    document.querySelectorAll('div, section, aside, form, dialog, article, nav').forEach(el => {
      const style = window.getComputedStyle(el);
      const zIndex = parseInt(style.zIndex) || 0;
      const pos = style.position;
      // Remove any fixed/sticky element with z-index > 10 that covers significant area
      if ((pos === 'fixed' || pos === 'sticky') && zIndex > 10) {
        const rect = el.getBoundingClientRect();
        // Skip navigation bars (typically at very top, full width, short height)
        const isNavBar = rect.top < 5 && rect.width > window.innerWidth * 0.8 && rect.height < 80;
        if (!isNavBar) {
          el.remove(); removed++;
        }
      }
      // Remove any element with very high z-index that looks like an overlay
      if (zIndex > 9000) {
        el.remove(); removed++;
      }
    });
    // Restore body
    document.body.style.overflow = 'auto';
    document.body.style.visibility = 'visible';
    document.documentElement.style.overflow = 'auto';
    ['klaviyo-prevent-body-scrolling', 'modal-open', 'popup-open', 'no-scroll', 'overflow-hidden'].forEach(c => {
      document.body.classList.remove(c);
    });
    return removed;
  });
  if (removedCount > 0) console.log(`Removed ${removedCount} overlay DOM elements`);

  // ── Phase 3: Capture + URL rewrite ────────────────────────────────────────
  let html = await page.content();

  // Decode HTML entities in src/srcset attributes (&amp; → &)
  html = html.replace(/srcset="([^"]+)"/g, (match, srcset) => {
    return `srcset="${srcset.replace(/&amp;/g, '&')}"`;
  });
  html = html.replace(/srcset='([^']+)'/g, (match, srcset) => {
    return `srcset='${srcset.replace(/&amp;/g, '&')}'`;
  });
  html = html.replace(/src="([^"]+)"/g, (match, src) => {
    return `src="${src.replace(/&amp;/g, '&')}"`;
  });
  html = html.replace(/src='([^']+)'/g, (match, src) => {
    return `src='${src.replace(/&amp;/g, '&')}'`;
  });

  // Rewrite all intercepted URLs to local paths (longest first)
  const sortedEntries = [...urlMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [originalUrl, localPath] of sortedEntries) {
    // Replace the full URL
    html = html.split(originalUrl).join(localPath);
    // Also replace the HTML-encoded version
    const encoded = originalUrl.replace(/&/g, '&amp;');
    if (encoded !== originalUrl) {
      html = html.split(encoded).join(localPath);
    }
  }

  // Write outputs
  fs.writeFileSync(path.join(jobDir, 'page.html'), html, 'utf8');
  fs.writeFileSync(path.join(jobDir, 'asset-manifest.json'), JSON.stringify(
    Object.fromEntries(urlMap), null, 2
  ), 'utf8');

  // Stats
  const imgVars = (html.match(/src=["'][^"']*\{\{[^}]+\}\}[^"']*["']/g) || []).length;
  console.log(`Captured: ${html.length} bytes, ${assetCounter} assets intercepted`);
  if (imgVars > 0) console.warn(`WARNING: ${imgVars} img tags still have unresolved template vars`);

  await browser.close();
  process.exit(0);
})().catch(err => {
  console.error('Capture error:', err.message);
  process.exit(1);
});
