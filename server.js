const express = require('express');
const { spawnSync } = require('child_process');
const { execSync } = require('child_process');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '100mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.post('/clone', async (req, res) => {
  const { url, instructions, uploads = [] } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const jobId = uuidv4();
  const jobDir = `/tmp/job-${jobId}`;
  const uploadsDir = `${jobDir}/uploads`;
  const assetsDir = `${jobDir}/assets`;

  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  console.log(`[${jobId}] Cloning: ${url}`);

  try {
    // Save uploads
    for (const upload of uploads) {
      const buf = Buffer.from(upload.base64, 'base64');
      fs.writeFileSync(`${uploadsDir}/${upload.name}`, buf);
      console.log(`[${jobId}] Saved upload: ${upload.name}`);
    }

    // Fetch rendered page HTML
    console.log(`[${jobId}] Fetching page...`);
    execSync(
      `curl -sL -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "${url}" -o "${jobDir}/page.html"`,
      { timeout: 30000 }
    );

    // Download assets via Python
    console.log(`[${jobId}] Downloading assets...`);
    execSync(`python3 /app/download-assets.py "${jobDir}"`, { timeout: 120000 });

    // Build Claude Code prompt
    const instructionsText = instructions || 'No changes — deploy the clone exactly as-is.';
    const vercelToken = process.env.VERCEL_TOKEN;
    const prompt = `You are cloning a landing page. Complete ALL steps autonomously. Do not stop, do not ask questions.

ORIGINAL URL: ${url}
RENDERED HTML FILE: ${jobDir}/page.html
ORIGINAL ASSETS FOLDER: ${jobDir}/assets/
UPLOADED BRAND ASSETS FOLDER: ${jobDir}/uploads/

CHANGES REQUESTED:
${instructionsText}

YOUR STEPS (execute all of them in order):
1. Read ${jobDir}/page.html
2. Apply every change described in CHANGES REQUESTED. Use your judgment about WHERE in the HTML/CSS each change belongs. For file swaps, find the right img/video element and update its src to point to the uploads/ path.
3. Ensure ALL remaining external asset URLs are replaced with local assets/ paths
4. Run: mkdir -p ${jobDir}/clone
5. Write the final modified HTML to ${jobDir}/clone/index.html
6. Run: cp -r ${jobDir}/assets ${jobDir}/clone/assets
7. Run: cp -r ${jobDir}/uploads ${jobDir}/clone/uploads 2>/dev/null || true
8. Write this exact content to ${jobDir}/clone/vercel.json: {"version":2}
9. Run this command exactly: cd ${jobDir}/clone && vercel deploy --prod --yes --scope grrow --token ${vercelToken}
10. On the VERY LAST LINE of your entire output, print exactly (no extra spaces): DEPLOYED_URL=https://[the-vercel-url]`;

    console.log(`[${jobId}] Running Claude Code...`);
    const result = spawnSync('claude', ['--dangerously-skip-permissions', '-p', prompt], {
      timeout: 300000,
      encoding: 'utf8',
      env: { ...process.env },
      maxBuffer: 20 * 1024 * 1024
    });

    const output = (result.stdout || '') + (result.stderr || '');
    console.log(`[${jobId}] Output tail:\n${output.slice(-800)}`);

    const match = output.match(/DEPLOYED_URL=(https:\/\/[^\s\n]+)/);
    if (!match) {
      throw new Error(`No DEPLOYED_URL in output. Tail: ${output.slice(-400)}`);
    }

    const deployedUrl = match[1].trim();
    console.log(`[${jobId}] Done: ${deployedUrl}`);
    res.json({ url: deployedUrl, jobId });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    res.status(500).json({ error: err.message, jobId });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Clone server on port ${PORT}`));
