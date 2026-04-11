/**
 * shopify-upload.js
 * Uploads a cloned landing page to Shopify:
 *   1. Uploads all assets to Shopify Files (CDN)
 *   2. Rewrites HTML asset paths to Shopify CDN URLs
 *   3. Creates a custom page template in the active theme
 *   4. Creates a Shopify page using that template
 *
 * Usage: node shopify-upload.js <jobDir> <pageName>
 *   Requires env vars: SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN
 *   jobDir must contain page.html and assets/
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const jobDir = process.argv[2];
const pageName = process.argv[3] || 'cloned-page';

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

if (!jobDir || !STORE || !TOKEN) {
  console.error('Usage: SHOPIFY_STORE=x SHOPIFY_ACCESS_TOKEN=x node shopify-upload.js <jobDir> [pageName]');
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
    if (body) req.write(body);
    req.end();
  });
}

function shopifyGraphQL(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const options = {
      hostname: STORE,
      path: '/admin/api/2024-01/graphql.json',
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function uploadFileToShopify(filePath, fileName) {
  // Step 1: Create a staged upload target
  const stageResult = await shopifyGraphQL(`
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `, {
    input: [{
      filename: fileName,
      mimeType: getMimeType(fileName),
      resource: 'FILE',
      httpMethod: 'POST',
    }]
  });

  const targets = stageResult?.data?.stagedUploadsCreate?.stagedTargets;
  if (!targets || targets.length === 0) {
    console.error('Stage failed:', JSON.stringify(stageResult?.data?.stagedUploadsCreate?.userErrors));
    return null;
  }

  const target = targets[0];

  // Step 2: Upload the file to the staged URL
  const fileBuffer = fs.readFileSync(filePath);
  const FormData = (await import('form-data')).default;
  const form = new FormData();

  for (const param of target.parameters) {
    form.append(param.name, param.value);
  }
  form.append('file', fileBuffer, { filename: fileName, contentType: getMimeType(fileName) });

  await new Promise((resolve, reject) => {
    const url = new URL(target.url);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: form.getHeaders(),
    };

    const proto = url.protocol === 'https:' ? https : require('http');
    const req = proto.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    form.pipe(req);
  });

  // Step 3: Create the file in Shopify
  const createResult = await shopifyGraphQL(`
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id alt }
        userErrors { field message }
      }
    }
  `, {
    files: [{
      originalSource: target.resourceUrl,
      alt: fileName,
    }]
  });

  // Step 4: Poll for the file URL (it takes a moment to process)
  const fileId = createResult?.data?.fileCreate?.files?.[0]?.id;
  if (!fileId) {
    console.error('File create failed:', JSON.stringify(createResult?.data?.fileCreate?.userErrors));
    return null;
  }

  // Wait and poll for the CDN URL
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const pollResult = await shopifyGraphQL(`
      query getFile($id: ID!) {
        node(id: $id) {
          ... on GenericFile { url }
          ... on MediaImage { image { url } }
        }
      }
    `, { id: fileId });

    const fileUrl = pollResult?.data?.node?.url || pollResult?.data?.node?.image?.url;
    if (fileUrl) return fileUrl;
  }

  return null;
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.avif': 'image/avif', '.ico': 'image/x-icon',
    '.css': 'text/css', '.js': 'application/javascript',
    '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
    '.mp4': 'video/mp4', '.webm': 'video/webm',
  };
  return types[ext] || 'application/octet-stream';
}

(async () => {
  console.log(`Uploading clone to Shopify (${STORE})...`);

  // 1. Upload all assets to Shopify Files
  let html = fs.readFileSync(htmlPath, 'utf8');
  const assetFiles = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  console.log(`Found ${assetFiles.length} assets to upload`);

  const assetUrlMap = {}; // local path -> Shopify CDN URL
  let uploaded = 0;

  for (const file of assetFiles) {
    const localPath = path.join(assetsDir, file);
    const stat = fs.statSync(localPath);
    if (stat.isDirectory() || stat.size === 0) continue;

    try {
      const cdnUrl = await uploadFileToShopify(localPath, file);
      if (cdnUrl) {
        assetUrlMap[`assets/${file}`] = cdnUrl;
        uploaded++;
        if (uploaded % 10 === 0) console.log(`  Uploaded ${uploaded}/${assetFiles.length}...`);
      }
    } catch (e) {
      console.error(`  Skip ${file}: ${e.message}`);
    }
  }
  console.log(`Uploaded ${uploaded}/${assetFiles.length} assets to Shopify CDN`);

  // 2. Rewrite HTML asset paths to Shopify CDN URLs
  const sortedPaths = Object.keys(assetUrlMap).sort((a, b) => b.length - a.length);
  for (const localPath of sortedPaths) {
    html = html.split(localPath).join(assetUrlMap[localPath]);
  }

  // 3. Get active theme ID
  const themesResp = await shopifyRequest('GET', '/admin/api/2024-01/themes.json');
  const activeTheme = themesResp.data.themes.find(t => t.role === 'main');
  if (!activeTheme) {
    console.error('No active theme found');
    process.exit(1);
  }
  console.log(`Active theme: ${activeTheme.name} (${activeTheme.id})`);

  // 4. Create a custom page template that renders raw HTML without Shopify wrapper
  const templateName = `page.clone-${pageName}.liquid`;
  const templateContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{ page.title }}</title>
</head>
<body>
  {{ page.content }}
</body>
</html>
  `.trim();

  const templateResp = await shopifyRequest('PUT',
    `/admin/api/2024-01/themes/${activeTheme.id}/assets.json`,
    { asset: { key: `templates/${templateName}`, value: templateContent } }
  );

  if (templateResp.status >= 400) {
    console.error('Template creation failed:', JSON.stringify(templateResp.data));
    // Fallback: use default page template
    console.log('Falling back to default page template');
  } else {
    console.log(`Created template: ${templateName}`);
  }

  // 5. Create the Shopify page with cloned HTML
  const slug = pageName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');
  const pageResp = await shopifyRequest('POST', '/admin/api/2024-01/pages.json', {
    page: {
      title: pageName,
      handle: slug,
      body_html: html,
      template_suffix: `clone-${pageName}`,
      published: true,
    }
  });

  if (pageResp.status >= 400) {
    // Template might not have worked, try without template_suffix
    console.log('Retrying without custom template...');
    const retryResp = await shopifyRequest('POST', '/admin/api/2024-01/pages.json', {
      page: {
        title: pageName,
        handle: slug,
        body_html: html,
        published: true,
      }
    });

    if (retryResp.status >= 400) {
      console.error('Page creation failed:', JSON.stringify(retryResp.data));
      process.exit(1);
    }
    const pageUrl = `https://${STORE.replace('.myshopify.com', '')}.com/pages/${slug}`;
    console.log(`Page created (default template): ${pageUrl}`);
    console.log(`Admin: https://admin.shopify.com/store/${STORE.split('.')[0]}/pages/${retryResp.data.page.id}`);
    console.log(`SHOPIFY_PAGE_URL=${pageUrl}`);
  } else {
    const pageUrl = `https://${STORE.replace('.myshopify.com', '')}.com/pages/${slug}`;
    console.log(`Page created: ${pageUrl}`);
    console.log(`Admin: https://admin.shopify.com/store/${STORE.split('.')[0]}/pages/${pageResp.data.page.id}`);
    console.log(`SHOPIFY_PAGE_URL=${pageUrl}`);
  }
})().catch(err => {
  console.error('Upload error:', err.message);
  process.exit(1);
});
