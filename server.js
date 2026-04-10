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

  const scriptDir = __dirname;
  const systemPrompt = `You are a landing page cloning agent. You have access to bash, read_file, and write_file tools. Complete the task fully — do not stop until you have a deployed Vercel URL.

Job directory: ${jobDir}
Script directory: ${scriptDir}
Vercel token: ${vercelToken}
Vercel scope: grrow

CRITICAL RULES:
- NEVER run the "claude" command in bash. Never. Not for any reason.
- Use ONLY these tools: bash (for curl, cp, mkdir, python3, vercel), read_file, write_file
- Use bash for all file system operations and deployments
- Use read_file to read HTML files
- Use write_file to write modified HTML files
- ALWAYS use the scripts at ${scriptDir}/ for capture and transforms. NEVER write your own capture scripts.`;

  const userMessage = `Clone this landing page and apply brand changes. Complete all steps autonomously.

URL: ${url}
Job dir: ${jobDir}
Vercel token: ${vercelToken}

BRAND CHANGES REQUESTED:
${instructions || 'No changes — deploy as exact clone.'}

IMPORTANT: The HTML file is large. DO NOT read it into your response. Instead, write Python scripts using write_file and run them with bash. This avoids token limits.

STEPS:
1. bash: node ${scriptDir}/playwright-capture.js "${url}" "${jobDir}" && echo "Captured: $(wc -c < ${jobDir}/page.html) bytes, $(ls ${jobDir}/assets/ | wc -l) assets"
2. bash: python3 ${scriptDir}/structural-transform.py "${jobDir}" "${url}" && echo "Structural transform OK"
3. bash: python3 -c "
import re
with open('${jobDir}/page.html','r',errors='ignore') as f: h=f.read()
titles=re.findall(r'<h[1-3][^>]*>([^<]{5,100})</h[1-3]>',h)[:5]
print('Headlines found:', titles)
print('Body tag present:', '<body' in h.lower())
print('Size:', len(h))
"
4. ${instructions && instructions.trim() !== 'No changes — deploy as exact clone.' ? `write_file a Python script at ${jobDir}/brand-transform.py that makes the brand changes listed below.

The script must:
   - Read the ENTIRE ${jobDir}/page.html into a variable called h
   - Make ONLY these targeted changes using str.replace() and re.sub():
     ${instructions}
   - For uploaded assets in ${jobDir}/uploads/, replace matching image src references with uploads/FILENAME
   - GLOBAL SWEEP (run after all targeted changes): detect the original product/brand name from h1/h2 headlines (the name that appears most) and replace EVERY occurrence: h = h.replace(original_name, new_name) — this catches testimonials, FAQ, body copy
   - For uploaded videos (.mp4/.mov/.webm): find id="video-poster-placeholder" and replace with <video controls style="width:100%;display:block;" playsinline><source src="uploads/FILENAME" type="video/mp4"></video>
   - Size check: if len(h) < original_len * 0.6: raise Exception("Output too small")
   - CRITICAL: Write the COMPLETE modified HTML back. Use: open('${jobDir}/page.html','w').write(h)
   - Print: f"Brand transform done. Size: {len(h)}"

Then run: bash: python3 ${jobDir}/brand-transform.py && echo "Brand transform OK"` : `bash: echo "No brand changes requested — skipping brand transform"`}
5. bash: mkdir -p ${jobDir}/clone-${jobId.slice(0,8)} && cp ${jobDir}/page.html ${jobDir}/clone-${jobId.slice(0,8)}/index.html && cp -r ${jobDir}/assets ${jobDir}/clone-${jobId.slice(0,8)}/assets && cp -r ${jobDir}/uploads ${jobDir}/clone-${jobId.slice(0,8)}/uploads 2>/dev/null || true
6. write_file: ${jobDir}/clone-${jobId.slice(0,8)}/vercel.json with content: {"version":2}
7. bash: cd ${jobDir}/clone-${jobId.slice(0,8)} && vercel deploy --prod --yes --scope grrow --token ${vercelToken} || (sleep 15 && vercel deploy --prod --yes --scope grrow --token ${vercelToken})
8. bash: curl -s -X PATCH "https://api.vercel.com/v9/projects/clone-${jobId.slice(0,8)}?slug=grrow" -H "Authorization: Bearer ${vercelToken}" -H "Content-Type: application/json" -d '{"ssoProtection":null}' && echo "SSO removed"
9. When step 8 says "SSO removed", output: TASK_COMPLETE`;

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
3. From the page headlines + user's description, determine EXACTLY these values (print each one):
   - ORIGINAL_BRAND: the brand/company name that appears most in headlines (e.g. "Sondur")
   - ORIGINAL_PRODUCT: the product name from the h1 (e.g. "Travel Cushion")
   - NEW_BRAND: the user's brand name from their description (or empty if not specified)
   - NEW_PRODUCT: the user's product name from their description (or empty if not specified)
   - NEW_CTA: the user's CTA text (or empty if not specified)
   - NEW_COLOR: hex color from user's description (or empty if not specified)
   - ORIGINAL_CTA: the most common CTA button text found in step 1

   Then write_file ${jobDir}/brand-transform.py using this EXACT template, filling in the values:

import re, os

with open('${jobDir}/page.html', 'r', encoding='utf-8', errors='ignore') as f:
    h = f.read()
original_len = len(h)

# Safe replace: only protects local asset file paths (assets/...), replaces EVERYWHERE else
def safe_replace(html, old, new):
    if not old or not new or old == new:
        return html
    # Protect only local asset paths — these contain hashed filenames that must not be renamed
    parts = re.split(r'((?:src|href|srcset)=["\\'\\'][^\\'\\'"]*assets/[^\\'\\'"]*["\\'\\'])', html)
    result = []
    for i, part in enumerate(parts):
        if i % 2 == 0:
            # Not an asset path — replace freely (text, alt attrs, titles, links, everything)
            result.append(part.replace(old, new))
        else:
            # Asset path — don't touch
            result.append(part)
    return ''.join(result)

# 1. Brand name replacement — catches ALL variations
ORIGINAL_BRAND = 'FILL_THIS'  # e.g. "Sondur"
NEW_BRAND = 'FILL_THIS'  # e.g. "CloudRest"
if ORIGINAL_BRAND and NEW_BRAND:
    h = safe_replace(h, ORIGINAL_BRAND, NEW_BRAND)
    h = safe_replace(h, ORIGINAL_BRAND.lower(), NEW_BRAND.lower())
    h = safe_replace(h, ORIGINAL_BRAND.upper(), NEW_BRAND.upper())
    h = safe_replace(h, ORIGINAL_BRAND.title(), NEW_BRAND.title())
    # Also catch the brand in URLs (e.g. nobltravel.com -> skycomforttravel.com)
    h = safe_replace(h, ORIGINAL_BRAND.lower() + 'travel', NEW_BRAND.lower() + 'travel')
    count = h.count(ORIGINAL_BRAND) + h.count(ORIGINAL_BRAND.lower()) + h.count(ORIGINAL_BRAND.upper())
    print(f'Brand: {ORIGINAL_BRAND} -> {NEW_BRAND} (remaining refs: {count})')

# 2. Product name replacement — all case variations
ORIGINAL_PRODUCT = 'FILL_THIS'  # e.g. "Travel Cushion"
NEW_PRODUCT = 'FILL_THIS'  # e.g. "CloudRest Pro"
if ORIGINAL_PRODUCT and NEW_PRODUCT:
    h = safe_replace(h, ORIGINAL_PRODUCT, NEW_PRODUCT)
    h = safe_replace(h, ORIGINAL_PRODUCT.lower(), NEW_PRODUCT.lower())
    h = safe_replace(h, ORIGINAL_PRODUCT.upper(), NEW_PRODUCT.upper())
    h = safe_replace(h, ORIGINAL_PRODUCT.title(), NEW_PRODUCT.title())
    # Handle hyphenated/slug versions (carry-on-all-in-one -> skycomfort-elite)
    orig_slug = ORIGINAL_PRODUCT.lower().replace(' ', '-')
    new_slug = NEW_PRODUCT.lower().replace(' ', '-')
    if orig_slug != ORIGINAL_PRODUCT.lower():
        h = safe_replace(h, orig_slug, new_slug)
    count = h.count(ORIGINAL_PRODUCT) + h.count(ORIGINAL_PRODUCT.lower())
    print(f'Product: {ORIGINAL_PRODUCT} -> {NEW_PRODUCT} (remaining refs: {count})')

# 3. CTA button text replacement — all case variations
ORIGINAL_CTA = 'FILL_THIS'  # e.g. "ADD TO CART"
NEW_CTA = 'FILL_THIS'  # e.g. "Buy CloudRest Pro Now"
if ORIGINAL_CTA and NEW_CTA:
    h = h.replace(ORIGINAL_CTA, NEW_CTA)
    h = h.replace(ORIGINAL_CTA.lower(), NEW_CTA)
    h = h.replace(ORIGINAL_CTA.upper(), NEW_CTA)
    h = h.replace(ORIGINAL_CTA.title(), NEW_CTA)
    # Also catch common CTA variants
    for variant in ['Add to Cart', 'ADD TO CART', 'Add To Cart', 'Buy Now', 'BUY NOW', 'Shop Now', 'SHOP NOW', 'Order Now', 'ORDER NOW']:
        if variant.lower() != NEW_CTA.lower():
            h = h.replace(variant, NEW_CTA)
    print(f'CTA: {ORIGINAL_CTA} -> {NEW_CTA}')

# 3b. Final brand sweep — catch ANYTHING remaining
# Run one more pass with plain string replacement on ALL text (not safe_replace)
# This catches compound words like "NoblY-Strap", "AboutNobl", footer links, etc.
if ORIGINAL_BRAND and NEW_BRAND:
    # Only replace in text nodes and attribute values, not in asset filenames
    remaining_before = h.lower().count(ORIGINAL_BRAND.lower())
    if remaining_before > 0:
        # Aggressive pass: replace everywhere EXCEPT inside assets/ paths
        lines = h.split('\\n')
        for i, line in enumerate(lines):
            if 'assets/' not in line:
                lines[i] = line.replace(ORIGINAL_BRAND, NEW_BRAND)
                lines[i] = lines[i].replace(ORIGINAL_BRAND.lower(), NEW_BRAND.lower())
                lines[i] = lines[i].replace(ORIGINAL_BRAND.upper(), NEW_BRAND.upper())
                lines[i] = lines[i].replace(ORIGINAL_BRAND.title(), NEW_BRAND.title())
            else:
                # Line has asset path, only replace outside the src/href attribute
                parts = re.split(r'(assets/[^"\\'\\'\\s>]+)', lines[i])
                for j in range(len(parts)):
                    if j % 2 == 0:
                        parts[j] = parts[j].replace(ORIGINAL_BRAND, NEW_BRAND)
                        parts[j] = parts[j].replace(ORIGINAL_BRAND.lower(), NEW_BRAND.lower())
                        parts[j] = parts[j].replace(ORIGINAL_BRAND.upper(), NEW_BRAND.upper())
                lines[i] = ''.join(parts)
        h = '\\n'.join(lines)
        remaining_after = h.lower().count(ORIGINAL_BRAND.lower())
        print(f'Final sweep: {remaining_before} -> {remaining_after} remaining brand refs')

# 4. Button color change (ONLY buttons, not page background)
NEW_COLOR = 'FILL_THIS'  # e.g. "#FF6B35" or empty
if NEW_COLOR and NEW_COLOR.startswith('#'):
    # Add inline style to button/a elements that look like CTAs
    def recolor_button(m):
        tag = m.group(0)
        if 'style="' in tag:
            tag = re.sub(r'background-color:\s*[^;]+;?', f'background-color:{NEW_COLOR};', tag)
            if f'background-color:{NEW_COLOR}' not in tag:
                tag = tag.replace('style="', f'style="background-color:{NEW_COLOR};')
        else:
            tag = tag.replace('>', f' style="background-color:{NEW_COLOR};color:white;">', 1)
        return tag
    # Match buttons by: class containing btn/button/cta/cart, OR any <button> tag, OR links with CTA text
    h = re.sub(r'<(?:a|button)[^>]*class=["\\'\\'][^\\'\\'"]*(?:btn|button|cta|add-to-cart|checkout|product-form|shopify-payment)[^\\'\\'"]*["\\'\\'][^>]*>', recolor_button, h, flags=re.I)
    # Also catch ALL <button> tags (most are CTAs)
    h = re.sub(r'<button[^>]*>', recolor_button, h, flags=re.I)
    # Inject a CSS rule as the most reliable approach
    color_css = f'<style id="clone-color-override">button, .btn, [class*="button"], [class*="cart"], [class*="cta"], input[type="submit"] {{ background-color: {NEW_COLOR} !important; }}</style>'
    if '</head>' in h:
        h = h.replace('</head>', color_css + '\\n</head>', 1)
    print(f'Color: buttons -> {NEW_COLOR}')

# 5. Uploaded file replacements
uploads_dir = '${jobDir}/uploads'
if os.path.exists(uploads_dir):
    for fname in os.listdir(uploads_dir):
        ext = fname.lower().split('.')[-1]
        if ext in ('jpg','jpeg','png','webp','gif','svg'):
            # Logo detection
            if 'logo' in fname.lower():
                h = re.sub(r'(<img[^>]+class=["\\'\\'][^\\'\\'"]*logo[^\\'\\'"]*["\\'\\'][^>]*src=["\\'\\'])([^\\'\\'"]+)(["\\'\\'])', f'\\\\1uploads/{fname}\\\\3', h, flags=re.I)
                print(f'Logo replaced with uploads/{fname}')
        elif ext in ('mp4','mov','webm'):
            h = re.sub(r'<img[^>]*id=["\\'\\']video-poster-placeholder["\\'\\'][^>]*/?>',
                f'<video controls style="width:100%;display:block;" playsinline><source src="uploads/{fname}" type="video/mp4"></video>', h, flags=re.I)
            print(f'Video replaced with uploads/{fname}')

# Safety check
if len(h) < original_len * 0.5:
    raise Exception(f'Output too small: {len(h)} vs {original_len}')

with open('${jobDir}/page.html', 'w', encoding='utf-8') as f:
    f.write(h)
print(f'Edit transform done. Size: {len(h)} ({len(h)/original_len:.0%})')

   CRITICAL: Replace ALL the 'FILL_THIS' values with the actual detected values from step 1. If a value is not applicable, set it to empty string ''.

4. bash: python3 ${jobDir}/brand-transform.py && echo "Edit transform OK"
5. bash: mkdir -p ${jobDir}/${projectName} && cp ${jobDir}/page.html ${jobDir}/${projectName}/index.html && cp -r ${jobDir}/assets ${jobDir}/${projectName}/assets 2>/dev/null || true && cp -r ${jobDir}/uploads ${jobDir}/${projectName}/uploads 2>/dev/null || true && echo "Files copied"
6. write_file: ${jobDir}/${projectName}/vercel.json with content: {"version":2}
7. bash: cd ${jobDir}/${projectName} && vercel deploy --prod --yes --scope grrow --name ${projectName} --token ${vercelToken} || (sleep 15 && vercel deploy --prod --yes --scope grrow --name ${projectName} --token ${vercelToken})
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

    // Fetch current HTML from the existing Vercel clone — retry up to 3 times
    let html = null, fetchErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const htmlResp = await fetch(cloneUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
        });
        if (!htmlResp.ok) throw new Error(`HTTP ${htmlResp.status}`);
        const candidate = await htmlResp.text();
        if (candidate.length < 1000) throw new Error(`HTML too small: ${candidate.length} bytes`);
        html = candidate;
        break;
      } catch (e) {
        fetchErr = e;
        console.log(`[${jobId}] Fetch attempt ${attempt} failed: ${e.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }
    if (!html) throw new Error(`Failed to fetch clone HTML after 3 attempts: ${fetchErr.message}`);
    fs.writeFileSync(`${jobDir}/page.html`, html, 'utf8');
    console.log(`[${jobId}] Fetched HTML: ${html.length} bytes`);

    // Download all assets from the existing clone
    const assetRefs = [...new Set(html.match(/assets\/[^\s"'<>]+/g) || [])];
    console.log(`[${jobId}] Downloading ${assetRefs.length} assets from existing clone...`);
    let downloaded = 0;
    for (const assetPath of assetRefs) {
      const cleanPath = assetPath.split('"')[0].split("'")[0].split(')')[0];
      const assetUrl = `${cloneUrl}/${cleanPath}`;
      const localPath = path.join(jobDir, cleanPath);
      try {
        const resp = await fetch(assetUrl);
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.length > 0) {
            fs.writeFileSync(localPath, buf);
            downloaded++;
          }
        }
      } catch (e) { /* skip failed assets */ }
    }
    console.log(`[${jobId}] Downloaded ${downloaded}/${assetRefs.length} assets`);

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
