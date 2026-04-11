/**
 * shopify-upload.js v3
 * Uploads a FULLY EDITABLE clone to Shopify.
 * Assets go to theme assets (fast PUT, no staged upload).
 * HTML goes into a custom .liquid template (no 512KB limit).
 * Creates a page using that template.
 *
 * Usage: node shopify-upload.js <jobDir> <pageName>
 *   Requires env vars: SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const jobDir = process.argv[2];
const pageName = process.argv[3] || 'cloned-page';

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

if (!jobDir || !STORE || !TOKEN) {
  console.error('Usage: SHOPIFY_STORE=x SHOPIFY_ACCESS_TOKEN=x node shopify-upload.js <jobDir> <pageName>');
  process.exit(1);
}

const assetsDir = path.join(jobDir, 'assets');
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
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  console.log(`Uploading full clone to Shopify (${STORE})...`);

  // 1. Get active theme
  const themesResp = await shopifyRequest('GET', '/admin/api/2024-01/themes.json');
  const activeTheme = themesResp.data.themes.find(t => t.role === 'main');
  if (!activeTheme) { console.error('No active theme'); process.exit(1); }
  const THEME_ID = activeTheme.id;
  console.log(`Theme: ${activeTheme.name} (${THEME_ID})`);

  // 2. Upload all assets to theme assets (base64 PUT, fast)
  let html = fs.readFileSync(htmlPath, 'utf8');
  const assetFiles = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter(f => {
    const stat = fs.statSync(path.join(assetsDir, f));
    return !stat.isDirectory() && stat.size > 0 && stat.size < 20 * 1024 * 1024; // skip files > 20MB
  }) : [];

  console.log(`Uploading ${assetFiles.length} assets to theme...`);
  const assetUrlMap = {};
  let uploaded = 0;
  let failed = 0;

  // Upload in batches of 5 (Shopify rate limit is 2 req/sec for assets)
  const BATCH_SIZE = 2;
  for (let i = 0; i < assetFiles.length; i += BATCH_SIZE) {
    const batch = assetFiles.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (file) => {
      const localPath = path.join(assetsDir, file);
      const assetKey = `assets/clone-${pageName}-${file}`;
      try {
        const b64 = fs.readFileSync(localPath).toString('base64');
        const resp = await shopifyRequest('PUT',
          `/admin/api/2024-01/themes/${THEME_ID}/assets.json`,
          { asset: { key: assetKey, attachment: b64 } }
        );
        if (resp.data?.asset?.public_url) {
          assetUrlMap[`assets/${file}`] = resp.data.asset.public_url;
          uploaded++;
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }
    });
    await Promise.all(promises);

    if ((uploaded + failed) % 20 === 0 || i + BATCH_SIZE >= assetFiles.length) {
      console.log(`  Progress: ${uploaded} uploaded, ${failed} failed / ${assetFiles.length} total`);
    }

    // Rate limit: wait 1 second between batches
    if (i + BATCH_SIZE < assetFiles.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.log(`Assets: ${uploaded} uploaded, ${failed} failed`);

  // 3. Rewrite HTML asset paths to Shopify CDN URLs
  const sortedPaths = Object.keys(assetUrlMap).sort((a, b) => b.length - a.length);
  for (const localPath of sortedPaths) {
    html = html.split(localPath).join(assetUrlMap[localPath]);
  }

  // 4. Create the full HTML as a .liquid template in the theme (NO size limit)
  // Wrap in a Liquid template that bypasses the theme layout
  const templateContent = html;
  const templateKey = `templates/page.clone-${pageName}.liquid`;

  const templateResp = await shopifyRequest('PUT',
    `/admin/api/2024-01/themes/${THEME_ID}/assets.json`,
    { asset: { key: templateKey, value: templateContent } }
  );

  if (templateResp.status >= 400) {
    console.error('Template creation failed:', JSON.stringify(templateResp.data).slice(0, 300));
    process.exit(1);
  }
  console.log(`Template created: ${templateKey} (${(html.length/1024).toFixed(0)}KB)`);

  // 5. Create a Shopify page that uses this template (body can be empty, template has the content)
  const slug = pageName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');

  // Use GraphQL (works with write_online_store_pages scope)
  const gqlResp = await shopifyRequest('POST', '/admin/api/2024-01/graphql.json', {
    query: `mutation {
      pageCreate(page: {
        title: "${pageName.replace(/"/g, '\\"')}"
        handle: "${slug}"
        body: "<p>This page uses a custom template. Edit the template in Online Store > Themes > Edit code > Templates > page.clone-${pageName}.liquid</p>"
        isPublished: true
        templateSuffix: "clone-${pageName}"
      }) {
        page { id handle title }
        userErrors { field message }
      }
    }`
  });

  const pageData = gqlResp.data?.data?.pageCreate;
  if (pageData?.userErrors?.length > 0) {
    console.error('Page errors:', JSON.stringify(pageData.userErrors));
  }

  const gid = pageData?.page?.id || '';
  const pageId = gid.split('/').pop();
  const storeSlug = STORE.split('.')[0];

  // Get store domain
  const shopResp = await shopifyRequest('GET', '/admin/api/2024-01/shop.json');
  const domain = shopResp.data?.shop?.domain || `${storeSlug}.myshopify.com`;

  const pageUrl = `https://${domain}/pages/${slug}`;
  const adminUrl = `https://admin.shopify.com/store/${storeSlug}/pages/${pageId}`;
  const editUrl = `https://admin.shopify.com/store/${storeSlug}/themes/${THEME_ID}/editor?template=page.clone-${pageName}`;

  console.log(`Page live: ${pageUrl}`);
  console.log(`Admin: ${adminUrl}`);
  console.log(`Edit template: ${editUrl}`);
  console.log(`SHOPIFY_PAGE_URL=${pageUrl}`);
  console.log(`SHOPIFY_ADMIN_URL=${adminUrl}`);
  console.log(`SHOPIFY_EDIT_URL=${editUrl}`);
})().catch(err => {
  console.error('Upload error:', err.message);
  process.exit(1);
});
