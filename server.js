const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '100mb' }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Tool: run a bash command and return output
function runBash(command) {
  // Hard block: never allow running the claude CLI
  if (/\bclaude\b/.test(command) && !command.includes('claudedata')) {
    return { success: false, output: 'Blocked: do not use the claude CLI. Use the provided tools (bash for curl/cp/python3/vercel, read_file, write_file) instead.' };
  }
  try {
    const out = execSync(command, { timeout: 60000, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    return { success: true, output: out };
  } catch (e) {
    return { success: false, output: (e.stdout || '') + (e.stderr || '') + e.message };
  }
}

// Tool: read a file
function readFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { success: true, content: content.slice(0, 8000) }; // cap at 8KB to stay within token limits
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Tool: write a file
function writeFile(filePath, content) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Agentic loop: Claude calls tools to clone the page
async function runCloneAgent(jobDir, url, instructions, vercelToken, jobId) {
  const tools = [
    {
      name: 'bash',
      description: 'Run a bash command. Use for curl, cp, mkdir, vercel deploy, etc.',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The bash command to run' } },
        required: ['command']
      }
    },
    {
      name: 'read_file',
      description: 'Read a file from disk. Returns first 50KB of content.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute file path' } },
        required: ['path']
      }
    },
    {
      name: 'write_file',
      description: 'Write content to a file on disk.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path' },
          content: { type: 'string', description: 'File content to write' }
        },
        required: ['path', 'content']
      }
    }
  ];

  const systemPrompt = `You are a landing page cloning agent. You have access to bash, read_file, and write_file tools. Complete the task fully — do not stop until you have a deployed Vercel URL.

Job directory: ${jobDir}
Vercel token: ${vercelToken}
Vercel scope: grrow

CRITICAL RULES:
- NEVER run the "claude" command in bash. Never. Not for any reason.
- Use ONLY these tools: bash (for curl, cp, mkdir, python3, vercel), read_file, write_file
- Use bash for all file system operations and deployments
- Use read_file to read HTML files
- Use write_file to write modified HTML files`;

  const userMessage = `Clone this landing page and apply brand changes. Complete all steps autonomously.

URL: ${url}
Job dir: ${jobDir}
Vercel token: ${vercelToken}

BRAND CHANGES REQUESTED:
${instructions || 'No changes — deploy as exact clone.'}

IMPORTANT: The HTML file is large. DO NOT read it into your response. Instead, write Python scripts using write_file and run them with bash. This avoids token limits.

STEPS:
1. bash: node /app/playwright-capture.js "${url}" ${jobDir}/page.html && echo "Fetched: $(wc -c < ${jobDir}/page.html) bytes"
2. bash: python3 /app/download-assets.py "${jobDir}" "${url}"
3. bash: python3 /app/structural-transform.py "${jobDir}" && echo "Structural transform OK"
4. bash: python3 -c "
import re
with open('${jobDir}/page.html','r',errors='ignore') as f: h=f.read()
titles=re.findall(r'<h[1-3][^>]*>([^<]{5,100})</h[1-3]>',h)[:5]
print('Headlines found:', titles)
print('Body tag present:', '<body' in h.lower())
print('Size:', len(h))
"
5. ${instructions && instructions.trim() !== 'No changes — deploy as exact clone.' ? `write_file a Python script at ${jobDir}/brand-transform.py that makes ONLY the brand changes listed below. Keep it simple — use only str.replace() and re.sub() for text substitution. Do NOT restructure or rewrite any HTML. Do NOT remove any tags. Do NOT touch video, scripts, or style blocks. ONLY change the specific text, colors, images, or copy requested.

The script must:
   - Read the ENTIRE ${jobDir}/page.html into a variable
   - Make ONLY these changes using simple string replacement:
     ${instructions}
   - For uploaded assets in ${jobDir}/uploads/, replace matching image src references with uploads/FILENAME
   - CRITICAL: Write the COMPLETE modified HTML back (must contain both <head> and <body>). Use: open('${jobDir}/page.html','w').write(html)
   - Print file size at end: print(f"Brand transform done. Size: {len(html)}")

Then run: bash: python3 ${jobDir}/brand-transform.py && echo "Brand transform OK"` : `bash: echo "No brand changes requested — skipping brand transform"`}
6. bash: mkdir -p ${jobDir}/clone-${jobId.slice(0,8)} && cp ${jobDir}/page.html ${jobDir}/clone-${jobId.slice(0,8)}/index.html && cp -r ${jobDir}/assets ${jobDir}/clone-${jobId.slice(0,8)}/assets && cp -r ${jobDir}/uploads ${jobDir}/clone-${jobId.slice(0,8)}/uploads 2>/dev/null || true
7. write_file: ${jobDir}/clone-${jobId.slice(0,8)}/vercel.json with content: {"version":2}
8. bash: cd ${jobDir}/clone-${jobId.slice(0,8)} && vercel deploy --prod --yes --scope grrow --token ${vercelToken}
9. bash: curl -s -X PATCH "https://api.vercel.com/v9/projects/clone-${jobId.slice(0,8)}?slug=grrow" -H "Authorization: Bearer ${vercelToken}" -H "Content-Type: application/json" -d '{"ssoProtection":null}' && echo "SSO removed"
10. When step 9 says "SSO removed", output: TASK_COMPLETE`;

  const messages = [{ role: 'user', content: userMessage }];
  let deployedUrl = null;
  let iterations = 0;
  const maxIterations = 30;

  while (iterations < maxIterations) {
    iterations++;
    console.log(`[Agent] Iteration ${iterations}`);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages
    });

    // Add assistant response to messages
    messages.push({ role: 'assistant', content: response.content });

    // Check for TASK_COMPLETE signal in text blocks
    for (const block of response.content) {
      if (block.type === 'text' && block.text.includes('TASK_COMPLETE')) {
        console.log(`[Agent] Task complete signal received`);
      }
    }

    if (response.stop_reason === 'end_turn') {
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`[Agent] Tool: ${block.name} | input: ${JSON.stringify(block.input).slice(0, 200)}`);
          let result;
          if (block.name === 'bash') {
            result = runBash(block.input.command);
            // URL is extracted from the agent's text block DEPLOYED_URL= output
          } else if (block.name === 'read_file') {
            result = readFile(block.input.path);
          } else if (block.name === 'write_file') {
            result = writeFile(block.input.path, block.input.content);
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result)
          });
        }
      }
      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      }
    }
  }

  // Always derive URL from known project name (deterministic, avoids agent URL parsing issues)
  const projectName = `clone-${jobId.slice(0,8)}`;
  const projectUrl = `https://${projectName}.vercel.app`;
  const check = await fetch(projectUrl, { method: 'HEAD' }).catch(() => null);
  if (check && check.status < 400) {
    deployedUrl = projectUrl;
    console.log(`[Agent] Verified project URL: ${deployedUrl}`);
  }

  return deployedUrl;
}

// ── Edit Agent: applies intelligent brand changes to an existing clone ────────
async function runEditAgent(jobDir, cloneUrl, projectName, description, vercelToken, jobId) {
  const tools = [
    {
      name: 'bash',
      description: 'Run a bash command. Use for curl, cp, mkdir, vercel deploy, python3, etc.',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The bash command to run' } },
        required: ['command']
      }
    },
    {
      name: 'read_file',
      description: 'Read a file from disk. Returns first 8KB of content.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute file path' } },
        required: ['path']
      }
    },
    {
      name: 'write_file',
      description: 'Write content to a file on disk.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path' },
          content: { type: 'string', description: 'File content to write' }
        },
        required: ['path', 'content']
      }
    }
  ];

  const systemPrompt = `You are a landing page brand editor agent. You have access to bash, read_file, and write_file tools. Complete the task fully — do not stop until you have a deployed Vercel URL.

Job directory: ${jobDir}
Vercel token: ${vercelToken}
Vercel scope: grrow
Target Vercel project: ${projectName}

CRITICAL RULES:
- NEVER run the "claude" command in bash. Never. Not for any reason.
- Use ONLY these tools: bash (for curl, cp, mkdir, python3, vercel), read_file, write_file
- The HTML is already at ${jobDir}/page.html (fetched from the existing clone)
- Uploaded files are at ${jobDir}/uploads/ — use them for asset replacements`;

  const userMessage = `Apply intelligent brand changes to this cloned landing page and redeploy it.

Clone URL: ${cloneUrl}
Target Vercel project: ${projectName}
Job dir: ${jobDir}

USER'S BRAND/PRODUCT DESCRIPTION:
${description || 'No description provided — keep existing content, just redeploy.'}

IMPORTANT: The HTML at ${jobDir}/page.html is already a static clone with local asset paths (assets/...). Do NOT re-download anything. Just edit the HTML and redeploy.

STEPS:
1. bash: python3 -c "
import re
with open('${jobDir}/page.html','r',errors='ignore') as f: h=f.read()
titles=re.findall(r'<h[1-3][^>]*>([^<]{5,120})</h[1-3]>',h)[:8]
ctabtns=re.findall(r'<(?:a|button)[^>]*>([^<]{3,60})</(?:a|button)>',h)[:6]
print('Headlines:', titles)
print('CTAs:', ctabtns)
print('Size:', len(h))
"
2. bash: ls -la ${jobDir}/uploads/ 2>/dev/null || echo "No uploads"
3. Based on the page headlines + user's description + uploaded file names, write_file ${jobDir}/brand-transform.py that:
   - Reads the ENTIRE ${jobDir}/page.html
   - Makes INTELLIGENT brand substitutions:
     * Find the original brand/product name (appears repeatedly in headlines) — replace with user's product name throughout
     * Replace headline copy with user's equivalent messaging
     * Replace benefit bullet text with user's benefits
     * Replace CTA button text with user's CTA
     * For uploaded IMAGE files (.jpg/.jpeg/.png/.webp/.gif/.svg in uploads/):
       - Use filename as hint: logo.png → find logo img src and replace, hero.jpg → find hero/main img src and replace
       - Replace matching img src attributes with uploads/FILENAME
     * For uploaded VIDEO files (.mp4/.mov/.webm in uploads/):
       - Find the video placeholder: id="video-poster-placeholder" img tag or id="video1" container
       - Replace with: <video controls style="width:100%;display:block;" playsinline><source src="uploads/FILENAME" type="video/mp4"></video>
     * If user specified a hex color, find the dominant brand color in inline styles/CSS and replace it
   - Use str.replace() and re.sub() ONLY — no restructuring, no removing tags
   - Write complete modified HTML back: open('${jobDir}/page.html','w').write(h)
   - Print: f"Edit transform done. Size: {len(h)}"
4. bash: python3 ${jobDir}/brand-transform.py && echo "Edit transform OK"
5. bash: mkdir -p ${jobDir}/${projectName} && cp ${jobDir}/page.html ${jobDir}/${projectName}/index.html && cp -r ${jobDir}/assets ${jobDir}/${projectName}/assets 2>/dev/null || true && cp -r ${jobDir}/uploads ${jobDir}/${projectName}/uploads 2>/dev/null || true && echo "Files copied"
6. write_file: ${jobDir}/${projectName}/vercel.json with content: {"version":2}
7. bash: cd ${jobDir}/${projectName} && vercel deploy --prod --yes --scope grrow --name ${projectName} --token ${vercelToken}
8. bash: curl -s -X PATCH "https://api.vercel.com/v9/projects/${projectName}?slug=grrow" -H "Authorization: Bearer ${vercelToken}" -H "Content-Type: application/json" -d '{"ssoProtection":null}' && echo "SSO removed"
9. When step 8 says "SSO removed", output: TASK_COMPLETE`;

  const messages = [{ role: 'user', content: userMessage }];
  let iterations = 0;
  const maxIterations = 25;

  while (iterations < maxIterations) {
    iterations++;
    console.log(`[Edit Agent] Iteration ${iterations}`);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages
    });

    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.includes('TASK_COMPLETE')) {
        console.log(`[Edit Agent] Task complete signal received`);
      }
    }

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`[Edit Agent] Tool: ${block.name} | input: ${JSON.stringify(block.input).slice(0, 200)}`);
          let result;
          if (block.name === 'bash') result = runBash(block.input.command);
          else if (block.name === 'read_file') result = readFile(block.input.path);
          else if (block.name === 'write_file') result = writeFile(block.input.path, block.input.content);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        }
      }
      if (toolResults.length > 0) messages.push({ role: 'user', content: toolResults });
    }
  }

  // URL is deterministic — same project name = same URL, just updated content
  const projectUrl = `https://${projectName}.vercel.app`;
  const check = await fetch(projectUrl, { method: 'HEAD' }).catch(() => null);
  if (check && check.status < 400) {
    console.log(`[Edit Agent] Verified URL: ${projectUrl}`);
    return projectUrl;
  }
  return null;
}

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.post('/clone', async (req, res) => {
  const { url, instructions, uploads = [] } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const jobId = uuidv4();
  const jobDir = `/tmp/job-${jobId}`;
  const uploadsDir = `${jobDir}/uploads`;

  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(`${jobDir}/assets`, { recursive: true });

  console.log(`[${jobId}] Starting clone: ${url}`);

  try {
    // Save uploaded files
    for (const upload of uploads) {
      const buf = Buffer.from(upload.base64, 'base64');
      fs.writeFileSync(`${uploadsDir}/${upload.name}`, buf);
      console.log(`[${jobId}] Saved: ${upload.name}`);
    }

    const vercelToken = process.env.VERCEL_TOKEN;
    const deployedUrl = await runCloneAgent(jobDir, url, instructions, vercelToken, jobId);

    if (!deployedUrl) throw new Error('Agent completed but no Vercel URL was found in output');

    console.log(`[${jobId}] Done: ${deployedUrl}`);
    res.json({ url: deployedUrl, jobId });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    res.status(500).json({ error: err.message, jobId });
  }
});

app.post('/edit', async (req, res) => {
  const { cloneUrl, description, uploads = [] } = req.body;
  if (!cloneUrl) return res.status(400).json({ error: 'cloneUrl required' });

  // Must be a clone-XXXXXXXX.vercel.app URL
  const projectMatch = cloneUrl.match(/https?:\/\/(clone-[a-f0-9]+)\.vercel\.app/);
  if (!projectMatch) return res.status(400).json({ error: 'cloneUrl must be a clone-XXXXXXXX.vercel.app URL' });
  const projectName = projectMatch[1];

  const jobId = uuidv4();
  const jobDir = `/tmp/edit-${jobId}`;
  const uploadsDir = `${jobDir}/uploads`;

  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(`${jobDir}/assets`, { recursive: true });

  console.log(`[${jobId}] Starting edit: ${cloneUrl} → project: ${projectName}`);

  try {
    // Save uploaded files
    for (const upload of uploads) {
      const buf = Buffer.from(upload.base64, 'base64');
      fs.writeFileSync(`${uploadsDir}/${upload.name}`, buf);
      console.log(`[${jobId}] Saved upload: ${upload.name} (${buf.length} bytes)`);
    }

    // Fetch current HTML from the existing Vercel clone
    const htmlResp = await fetch(cloneUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    if (!htmlResp.ok) throw new Error(`Failed to fetch clone HTML: HTTP ${htmlResp.status}`);
    const html = await htmlResp.text();
    if (html.length < 1000) throw new Error(`Fetched HTML too small (${html.length} bytes) — clone URL may be invalid`);
    fs.writeFileSync(`${jobDir}/page.html`, html, 'utf8');
    console.log(`[${jobId}] Fetched HTML: ${html.length} bytes`);

    const vercelToken = process.env.VERCEL_TOKEN;
    const deployedUrl = await runEditAgent(jobDir, cloneUrl, projectName, description, vercelToken, jobId);

    if (!deployedUrl) throw new Error('Edit agent completed but URL verification failed');
    console.log(`[${jobId}] Edit done: ${deployedUrl}`);
    res.json({ url: deployedUrl, jobId });

  } catch (err) {
    console.error(`[${jobId}] Edit error:`, err.message);
    res.status(500).json({ error: err.message, jobId });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Clone server on port ${PORT}`));
