/**
 * shopify-upload.js v4
 * Converts a cloned landing page into fully editable Shopify sections.
 *
 * Architecture:
 *   1. Upload assets to theme assets (base64 PUT)
 *   2. Strip header/nav from cloned HTML (not needed for cloned pages)
 *   3. Split body HTML into chunks under 200KB each
 *   4. Create each chunk as a Liquid section with raw HTML
 *   5. Create a JSON template referencing all sections (layout: "clone" = no theme wrapper)
 *   6. Create a Shopify page using that template
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
const THEME_ID_CACHE = {};

function shopifyPut(endpoint, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname: STORE,
      path: endpoint,
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function shopifyPost(endpoint, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname: STORE,
      path: endpoint,
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function shopifyGet(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: STORE,
      path: endpoint,
      method: 'GET',
      headers: { 'X-Shopify-Access-Token': TOKEN },
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function shopifyDelete(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: STORE,
      path: endpoint,
      method: 'DELETE',
      headers: { 'X-Shopify-Access-Token': TOKEN },
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  console.log(`Uploading to Shopify (${STORE})...`);

  // 1. Get active theme
  const themes = await shopifyGet('/admin/api/2024-01/themes.json');
  const activeTheme = themes.themes.find(t => t.role === 'main');
  if (!activeTheme) { console.error('No active theme'); process.exit(1); }
  const THEME = activeTheme.id;
  console.log(`Theme: ${activeTheme.name} (${THEME})`);

  // 2. Ensure blank clone layout exists
  const layoutResp = await shopifyPut(`/admin/api/2024-01/themes/${THEME}/assets.json`, {
    asset: {
      key: 'layout/clone.liquid',
      value: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{ page.title }}</title>
{{ content_for_header }}
</head>
<body>
{{ content_for_layout }}
</body>
</html>`
    }
  });
  console.log(`Clone layout: ${layoutResp.status < 400 ? 'OK' : 'FAILED'}`);

  // 3. Upload assets to theme
  let html = fs.readFileSync(htmlPath, 'utf8');
  const assetFiles = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter(f => {
    const s = fs.statSync(path.join(assetsDir, f));
    return !s.isDirectory() && s.size > 0 && s.size < 20 * 1024 * 1024;
  }) : [];

  console.log(`Uploading ${assetFiles.length} assets...`);
  const urlMap = {};
  let uploaded = 0, failed = 0;

  for (let i = 0; i < assetFiles.length; i += 2) {
    const batch = assetFiles.slice(i, i + 2);
    await Promise.all(batch.map(async (file) => {
      const key = `assets/clone-${pageName}-${file}`;
      try {
        const b64 = fs.readFileSync(path.join(assetsDir, file)).toString('base64');
        const r = await shopifyPut(`/admin/api/2024-01/themes/${THEME}/assets.json`,
          { asset: { key, attachment: b64 } });
        if (r.data?.asset?.public_url) {
          urlMap[`assets/${file}`] = r.data.asset.public_url;
          uploaded++;
        } else { failed++; }
      } catch { failed++; }
    }));
    if ((uploaded + failed) % 50 === 0) console.log(`  ${uploaded}/${assetFiles.length} uploaded`);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`Assets: ${uploaded} OK, ${failed} failed`);

  // 4. Rewrite HTML with Shopify CDN URLs
  for (const [local, cdn] of Object.entries(urlMap).sort((a, b) => b[0].length - a[0].length)) {
    html = html.split(local).join(cdn);
  }

  // 5. Strip header/nav and scripts from body
  // Remove <header> and <nav> elements (clone doesn't need original brand navigation)
  html = html.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  html = html.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  // Remove scripts
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
  // Remove comments
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  // Collapse whitespace
  html = html.replace(/\n\s*\n+/g, '\n');

  // Extract body content
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  let bodyHtml = bodyMatch ? bodyMatch[1] : html;

  // Extract <style> blocks from <head> for the CSS
  const headMatch = html.match(/<head[^>]*>([\s\S]*)<\/head>/i);
  let headCss = '';
  if (headMatch) {
    const styles = headMatch[1].match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];
    headCss = styles.join('\n');
    const cssLinks = headMatch[1].match(/<link[^>]+rel=["']stylesheet["'][^>]*\/?>/gi) || [];
    headCss = cssLinks.slice(0, 5).join('\n') + '\n' + headCss;
  }

  // Escape Liquid syntax in the cloned HTML ({{ and {% would break Shopify)
  bodyHtml = bodyHtml.replace(/\{\{/g, '{% raw %}{{{% endraw %}');
  bodyHtml = bodyHtml.replace(/\{%/g, '{% raw %}{%{% endraw %}');

  console.log(`Body: ${(bodyHtml.length / 1024).toFixed(0)}KB`);

  // 6. Split body into sections (each under 200KB to stay within 256KB limit with schema)
  const CHUNK_MAX = 180 * 1024; // 180KB to leave room for schema
  const sections = [];
  let current = '';

  // Split at major HTML landmarks
  const parts = bodyHtml.split(/(?=<(?:section|div\s+(?:id|class)=["'][^"']*["'])[^>]*>)/i);
  for (const part of parts) {
    if (current.length + part.length > CHUNK_MAX && current.length > 0) {
      sections.push(current);
      current = part;
    } else {
      current += part;
    }
  }
  if (current) sections.push(current);

  console.log(`Split into ${sections.length} sections (${sections.map(s => (s.length/1024).toFixed(0) + 'KB').join(', ')})`);

  // 7. Upload each section as a .liquid file with schema
  const sectionNames = [];
  for (let i = 0; i < sections.length; i++) {
    const sectionName = `clone-${pageName}-${i}`;
    const sectionKey = `sections/${sectionName}.liquid`;

    // First section gets the CSS
    const cssBlock = i === 0 ? headCss : '';

    const sectionContent = `${cssBlock}\n${sections[i]}\n{% schema %}\n{"name":"Clone Section ${i + 1}","settings":[]}\n{% endschema %}`;

    if (sectionContent.length > 256 * 1024) {
      console.log(`  Section ${i}: ${(sectionContent.length/1024).toFixed(0)}KB - TOO LARGE, trimming...`);
      // Trim to fit
      const maxBody = 250 * 1024 - cssBlock.length - 100;
      const trimmed = `${cssBlock}\n${sections[i].slice(0, maxBody)}\n{% schema %}\n{"name":"Clone Section ${i + 1}","settings":[]}\n{% endschema %}`;
      const r = await shopifyPut(`/admin/api/2024-01/themes/${THEME}/assets.json`,
        { asset: { key: sectionKey, value: trimmed } });
      if (r.data?.asset) { sectionNames.push(sectionName); console.log(`  Section ${i}: trimmed OK`); }
      else { console.log(`  Section ${i}: FAILED ${JSON.stringify(r.data).slice(0, 100)}`); }
    } else {
      const r = await shopifyPut(`/admin/api/2024-01/themes/${THEME}/assets.json`,
        { asset: { key: sectionKey, value: sectionContent } });
      if (r.data?.asset) {
        sectionNames.push(sectionName);
        console.log(`  Section ${i}: ${(sectionContent.length/1024).toFixed(0)}KB OK`);
      } else {
        console.log(`  Section ${i}: FAILED ${JSON.stringify(r.data).slice(0, 200)}`);
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (sectionNames.length === 0) {
    console.error('No sections created');
    process.exit(1);
  }

  // 8. Create JSON template referencing all sections
  const templateData = {
    layout: 'clone',
    sections: {},
    order: [],
  };
  for (const name of sectionNames) {
    templateData.sections[name] = { type: name, settings: {} };
    templateData.order.push(name);
  }

  const templateKey = `templates/page.clone-${pageName}.json`;
  const templateResp = await shopifyPut(`/admin/api/2024-01/themes/${THEME}/assets.json`, {
    asset: { key: templateKey, value: JSON.stringify(templateData) }
  });
  console.log(`Template: ${templateResp.status < 400 ? 'OK' : 'FAILED'}`);

  // 9. Create page
  const slug = pageName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const gqlResp = await shopifyPost('/admin/api/2024-01/graphql.json', {
    query: `mutation {
      pageCreate(page: {
        title: "${pageName.replace(/"/g, '\\"')}"
        handle: "${slug}"
        body: "<p>Editable clone page</p>"
        isPublished: true
        templateSuffix: "clone-${pageName}"
      }) {
        page { id handle }
        userErrors { field message }
      }
    }`
  });

  const pd = gqlResp.data?.data?.pageCreate;
  if (pd?.userErrors?.length) console.log('Page errors:', pd.userErrors);

  const pageId = pd?.page?.id?.split('/').pop() || '';
  const storeSlug = STORE.split('.')[0];
  const shopResp = await shopifyGet('/admin/api/2024-01/shop.json');
  const domain = shopResp?.shop?.domain || STORE;

  console.log(`\nDONE!`);
  console.log(`Page: https://${domain}/pages/${slug}`);
  console.log(`Admin: https://admin.shopify.com/store/${storeSlug}/pages/${pageId}`);
  console.log(`Edit in theme editor: Online Store > Themes > Customize > Pages > clone-${pageName}`);
  console.log(`SHOPIFY_PAGE_URL=https://${domain}/pages/${slug}`);
  console.log(`SHOPIFY_ADMIN_URL=https://admin.shopify.com/store/${storeSlug}/pages/${pageId}`);
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
