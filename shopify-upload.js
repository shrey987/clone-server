/**
 * shopify-upload.js v2
 * Creates a Shopify page from a cloned landing page.
 * Assets stay on Vercel (fast CDN). Only the HTML goes to Shopify.
 *
 * Usage: node shopify-upload.js <jobDir> <pageName> <vercelUrl>
 *   vercelUrl = the Vercel deployment URL where assets are hosted
 *   Requires env vars: SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const jobDir = process.argv[2];
const pageName = process.argv[3] || 'cloned-page';
const vercelUrl = process.argv[4] || '';

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

if (!jobDir || !STORE || !TOKEN) {
  console.error('Usage: SHOPIFY_STORE=x SHOPIFY_ACCESS_TOKEN=x node shopify-upload.js <jobDir> <pageName> [vercelUrl]');
  process.exit(1);
}

const htmlPath = path.join(jobDir, 'page.html');

function shopifyRequest(method, endpoint, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const options = {
      hostname: STORE,
      path: endpoint,
      method,
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(responseData) });
        } catch {
          resolve({ status: res.statusCode, data: responseData });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  console.log(`Creating Shopify page on ${STORE}...`);

  let html = fs.readFileSync(htmlPath, 'utf8');

  // If Vercel URL provided, rewrite local asset paths to Vercel CDN
  if (vercelUrl) {
    html = html.replace(/assets\//g, `${vercelUrl}/assets/`);
    console.log(`Asset URLs rewritten to ${vercelUrl}/assets/`);
  }

  // Get active theme
  const themesResp = await shopifyRequest('GET', '/admin/api/2024-01/themes.json');
  const activeTheme = themesResp.data.themes.find(t => t.role === 'main');
  if (!activeTheme) {
    console.error('No active theme found');
    process.exit(1);
  }
  console.log(`Active theme: ${activeTheme.name} (${activeTheme.id})`);

  // Create a custom page template (renders raw HTML, no Shopify theme wrapper)
  const templateSuffix = `clone-${pageName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  const templateKey = `templates/page.${templateSuffix}.liquid`;
  const templateContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{ page.title }}</title>
</head>
<body>
  {{ page.content }}
</body>
</html>`;

  const templateResp = await shopifyRequest('PUT',
    `/admin/api/2024-01/themes/${activeTheme.id}/assets.json`,
    { asset: { key: templateKey, value: templateContent } }
  );

  if (templateResp.status >= 400) {
    console.log('Custom template creation failed, using default page template');
  } else {
    console.log(`Created template: ${templateKey}`);
  }

  // Create the Shopify page
  const slug = pageName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');

  // Check if page already exists with this handle
  const existingResp = await shopifyRequest('GET', `/admin/api/2024-01/pages.json?handle=${slug}`);
  const existingPage = existingResp.data?.pages?.[0];

  let pageResp;
  if (existingPage) {
    // Update existing page
    pageResp = await shopifyRequest('PUT', `/admin/api/2024-01/pages/${existingPage.id}.json`, {
      page: {
        id: existingPage.id,
        body_html: html,
        template_suffix: templateResp.status < 400 ? templateSuffix : undefined,
      }
    });
    console.log(`Updated existing page: ${existingPage.id}`);
  } else {
    // Create new page
    pageResp = await shopifyRequest('POST', '/admin/api/2024-01/pages.json', {
      page: {
        title: pageName,
        handle: slug,
        body_html: html,
        template_suffix: templateResp.status < 400 ? templateSuffix : undefined,
        published: true,
      }
    });
  }

  if (pageResp.status >= 400) {
    // Retry without template suffix
    pageResp = await shopifyRequest('POST', '/admin/api/2024-01/pages.json', {
      page: {
        title: pageName,
        handle: slug,
        body_html: html,
        published: true,
      }
    });
  }

  if (pageResp.status >= 400) {
    console.error('Page creation failed:', JSON.stringify(pageResp.data).slice(0, 500));
    process.exit(1);
  }

  const pageId = pageResp.data?.page?.id || existingPage?.id;
  const storeSlug = STORE.split('.')[0];

  // Get the store's primary domain for the public URL
  const shopResp = await shopifyRequest('GET', '/admin/api/2024-01/shop.json');
  const domain = shopResp.data?.shop?.domain || `${storeSlug}.myshopify.com`;

  const pageUrl = `https://${domain}/pages/${slug}`;
  const adminUrl = `https://admin.shopify.com/store/${storeSlug}/pages/${pageId}`;

  console.log(`Page live: ${pageUrl}`);
  console.log(`Edit in Shopify: ${adminUrl}`);
  console.log(`SHOPIFY_PAGE_URL=${pageUrl}`);
  console.log(`SHOPIFY_ADMIN_URL=${adminUrl}`);
})().catch(err => {
  console.error('Upload error:', err.message);
  process.exit(1);
});
