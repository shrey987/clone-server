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
    return { success: true, content: content.slice(0, 50000) }; // cap at 50KB
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
async function runCloneAgent(jobDir, url, instructions, vercelToken) {
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

  const userMessage = `Clone this landing page: ${url}

CHANGES TO MAKE:
${instructions || 'No changes — deploy as exact clone.'}

STEPS:
1. Fetch the page: curl -sL -A "Mozilla/5.0" "${url}" -o ${jobDir}/page.html
2. Run: python3 /app/download-assets.py "${jobDir}"
3. Read ${jobDir}/page.html (first 30KB to understand structure)
4. Apply the changes described above — modify the HTML directly using write_file
5. Fix any lazy-loaded images (src="" with data-src) — set src = data-src value
6. Create ${jobDir}/clone/ directory
7. Write modified HTML to ${jobDir}/clone/index.html
8. Copy assets: cp -r ${jobDir}/assets ${jobDir}/clone/assets
9. Copy uploads if any: cp -r ${jobDir}/uploads ${jobDir}/clone/uploads 2>/dev/null || true
10. Write ${jobDir}/clone/vercel.json with content: {"version":2}
11. Deploy: cd ${jobDir}/clone && vercel deploy --prod --yes --scope grrow --token ${vercelToken}
12. Return the Vercel URL from the deploy output

After deploying, output the final URL on its own line as: DEPLOYED_URL=https://...`;

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

    // Check for DEPLOYED_URL in text blocks
    for (const block of response.content) {
      if (block.type === 'text') {
        const match = block.text.match(/DEPLOYED_URL=(https:\/\/[^\s\n]+)/);
        if (match) {
          deployedUrl = match[1].trim();
          console.log(`[Agent] Got URL: ${deployedUrl}`);
        }
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
            // Check if deploy output has a URL
            if (block.input.command.includes('vercel deploy')) {
              const match = (result.output || '').match(/https:\/\/[a-z0-9-]+\.vercel\.app/g);
              if (match) deployedUrl = match[match.length - 1];
            }
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

  return deployedUrl;
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
    const deployedUrl = await runCloneAgent(jobDir, url, instructions, vercelToken);

    if (!deployedUrl) throw new Error('Agent completed but no Vercel URL was found in output');

    console.log(`[${jobId}] Done: ${deployedUrl}`);
    res.json({ url: deployedUrl, jobId });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    res.status(500).json({ error: err.message, jobId });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Clone server on port ${PORT}`));
