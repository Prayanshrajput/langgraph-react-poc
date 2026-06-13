import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { logAICall, logStep, getCallLog, ensureLogDir, LOG_FILE } from './logger.js';
import { pushToGitHub, createGitHubRepo, deployToCloudflarePages } from './deployer.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Anthropic();
const isWin = process.platform === 'win32';

const GENERATED_DIR = path.join(__dirname, 'generated');
const BASE_DIR = path.join(GENERATED_DIR, 'base');

const projects = new Map();

// ─── Base Vite template (one-time install) ────────────────────────────────────

const BASE_FILES = {
  'package.json': JSON.stringify({
    name: 'preview', private: true, version: '0.0.1', type: 'module',
    scripts: { dev: 'vite', build: 'tsc -b && vite build' },
    dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
    devDependencies: {
      '@types/react': '^18.3.1', '@types/react-dom': '^18.3.1',
      '@vitejs/plugin-react': '^4.3.1', typescript: '^5.5.3', vite: '^5.4.1',
    },
  }, null, 2),
  'tsconfig.json': `{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }`,
  'tsconfig.app.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2020', useDefineForClassFields: true,
      lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext',
      skipLibCheck: true, moduleResolution: 'bundler',
      allowImportingTsExtensions: true, isolatedModules: true,
      moduleDetection: 'force', noEmit: true, jsx: 'react-jsx', strict: true,
    },
    include: ['src'],
  }, null, 2),
};


// Fixed files — identical every project, so we never spend AI tokens generating them.
const MAIN_TSX = `import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
`;
const INDEX_CSS = `body { margin: 0; }\n`;

// These are written from templates, never AI-generated. They still appear in the
// manifest (marked do-not-edit) so the update flow knows they exist.
const FIXED_FILES = {
  'src/main.tsx': MAIN_TSX,
  'src/index.css': INDEX_CSS,
};

async function writeFixedFiles(projectDir) {
  for (const [rel, content] of Object.entries(FIXED_FILES)) {
    const dest = path.join(projectDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, 'utf-8');
  }
}

// ─── Manifest (the project "skill") ───────────────────────────────────────────
// A small index of every file + a one-line description of what it does. The update
// flow reads this first (cheap) to decide which files to actually open and edit.

function manifestPath(projectDir) {
  return path.join(projectDir, '_manifest.json');
}

async function saveManifest(projectDir, fileEntries) {
  const manifest = {
    files: [
      { path: 'src/main.tsx', description: 'App entry point (boilerplate — do not edit)' },
      { path: 'src/index.css', description: 'Global CSS reset (do not edit)' },
      ...fileEntries.map((f) => ({ path: f.path, description: f.description || '' })),
    ],
  };
  await fs.writeFile(manifestPath(projectDir), JSON.stringify(manifest, null, 2), 'utf-8');
  return manifest;
}

async function loadManifest(proj) {
  // Prefer the saved manifest; fall back to a path-only manifest for older projects.
  try {
    const raw = await fs.readFile(manifestPath(proj.dir), 'utf-8');
    return JSON.parse(raw);
  } catch {
    const files = await getSrcFiles(proj.dir);
    return { files: files.map((p) => ({ path: p, description: '' })) };
  }
}

async function ensureBase() {
  const marker = path.join(BASE_DIR, 'node_modules', '.package-lock.json');
  try { await fs.access(marker); return; } catch {}
  console.log('[setup] Installing base Vite template (~30s, one-time)...');
  await fs.mkdir(BASE_DIR, { recursive: true });
  await Promise.all(Object.entries(BASE_FILES).map(([n, c]) => fs.writeFile(path.join(BASE_DIR, n), c, 'utf-8')));
  // Minimal package.json for npm install
  await new Promise((resolve, reject) => {
    const proc = spawn(isWin ? 'npm.cmd' : 'npm', ['install'], { cwd: BASE_DIR, stdio: 'inherit', shell: isWin });
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`npm install failed: ${code}`)));
  });
  console.log('[setup] Base template ready.');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getSrcFiles(projectDir) {
  const files = [];
  const walk = async (dir, base = '') => {
    try {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
        else files.push(`src/${rel}`);
      }
    } catch {}
  };
  await walk(path.join(projectDir, 'src'));
  return files;
}

async function ensureJunction(projectDir) {
  const nm = path.join(projectDir, 'node_modules');
  try { await fs.access(nm); } catch {
    await fs.symlink(path.join(BASE_DIR, 'node_modules'), nm, 'junction');
  }
}


// ─── esbuild preview ──────────────────────────────────────────────────────────
// Bundles in 1-3s, outputs static dist/ — zero running processes, zero RAM overhead.

const PREVIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="bundle.css" />
  <title>Preview</title>
</head>
<body class="m-0">
  <div id="root"></div>
  <script type="module" src="bundle.js"></script>
</body>
</html>`;

async function buildWithEsbuild(projectId) {
  const proj = projects.get(projectId);
  if (!proj) throw new Error('Project not found: ' + projectId);

  // Ensure node_modules symlink exists so esbuild can resolve react, react-dom, etc.
  await ensureJunction(proj.dir);

  // Remove AI-generated config files that would conflict
  for (const bad of ['postcss.config.js', 'postcss.config.cjs', 'tailwind.config.js', 'tailwind.config.ts']) {
    try { await fs.unlink(path.join(proj.dir, bad)); } catch {}
  }

  const distDir = path.join(proj.dir, 'dist');
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(path.join(distDir, 'index.html'), PREVIEW_HTML, 'utf-8');

  const t0 = Date.now();
  logStep('esbuild', projectId, 'bundling…', null);

  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [path.join(proj.dir, 'src/main.tsx')],
    bundle: true,
    outfile: path.join(distDir, 'bundle.js'),
    format: 'esm',
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.jsx': 'jsx', '.js': 'js', '.css': 'css', '.svg': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    platform: 'browser',
    minify: false,
    logLevel: 'error',
  });

  logStep('esbuild', projectId, 'bundle ready', Date.now() - t0);
  Object.assign(proj, { built: true });
  return `/preview/${projectId}/`;
}

async function scanExistingProjects() {
  try {
    for (const e of await fs.readdir(GENERATED_DIR, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('project-')) continue;
      const projectDir = path.join(GENERATED_DIR, e.name);
      const stamp = parseInt(e.name.replace('project-', ''), 10);
      const files = await getSrcFiles(projectDir);

      // Check if dist/ was already built before the restart
      let built = false;
      try { await fs.access(path.join(projectDir, 'dist', 'bundle.js')); built = true; } catch {}

      projects.set(e.name, { id: e.name, dir: projectDir, files, createdAt: isNaN(stamp) ? 0 : stamp, built });
    }
    console.log(`[scan] ${projects.size} project(s) found.`);
  } catch {}
}


// ─── Claude prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior React TypeScript engineer.

Given a requirement, generate a COMPLETE, production-quality Vite React TypeScript project.

ALREADY PROVIDED — do NOT generate these (they are fixed boilerplate):
  src/main.tsx              — entry point, imports './index.css' and renders <App />
  src/index.css             — global reset
  vite.config.ts            — managed by the server (do NOT generate)
  index.html                — managed by the server (do NOT generate)
  tsconfig.json             — managed by the server (do NOT generate)
  tsconfig.app.json         — managed by the server (do NOT generate)
  package.json              — managed by the server (do NOT generate)
  postcss.config.js         — do NOT generate (Tailwind is loaded via CDN, no PostCSS)
  tailwind.config.js        — do NOT generate (Tailwind is loaded via CDN, no PostCSS)

Files YOU must generate — ALL under src/ only:
  src/App.tsx               — Root layout + routing between pages/views
  src/types/index.ts        — ALL TypeScript interfaces, types, enums
  src/data/mockData.ts      — Rich realistic demo data (min 8–10 items per entity)
  src/components/*.tsx      — Reusable UI components, one default export per file
  src/hooks/*.ts            — Custom hooks (only if genuinely needed)
  src/pages/*.tsx           — Page/view components (one per screen)

Rules:
  - Every file path MUST start with "src/" — never generate root-level config files
  - Every file has exactly one default export
  - All props typed via interfaces from types/index.ts
  - Tailwind CSS for ALL styling (loaded via CDN in HTML — do NOT import or install it)
  - Every interactive element actually works
  - Use React.FC<Props> with explicit prop types
  - Mock data lives only in data/mockData.ts
  - For EACH file, provide a concise one-line "description" of what it contains/does.
    These descriptions become the project map used for future edits — make them
    specific (e.g. "TaskCard: renders one task with priority badge and assignee avatar").`;

const SELECT_SYSTEM = `You are editing an existing React TypeScript project.

You are given the project's file manifest (each file's path + a description of what it
does) and a change request. Your job is ONLY to decide which files must be opened to
make this change. Pick the minimum set:
  - Files whose code must change
  - Files needed for context (e.g. types/index.ts if adding a typed field, data/mockData.ts if changing demo data)

Never select main.tsx or index.css (they are fixed boilerplate). Be precise — selecting
too many files wastes effort; selecting too few means the edit will be wrong.`;

const EDIT_SYSTEM = `You are editing an existing React TypeScript project.

You are given the FULL current content of the relevant files and a change request.
Apply the change carefully and return the COMPLETE new content for every file you modify.
You may also create new files if the change genuinely needs them.

Rules:
  - Return full file content, not diffs or snippets
  - Only return files that actually change — do not echo unchanged files
  - Keep the existing code style, imports, and Tailwind usage
  - Do not break other parts of the app; respect the existing types and data shapes
  - For each returned file include a concise one-line "description" for the project map`;

// ─── Token / cost tracking ────────────────────────────────────────────────────
// Sonnet 4.6 pricing: $3/1M input, $15/1M output
const PRICE = { input: 3 / 1_000_000, output: 15 / 1_000_000 };

function calcCost(usage) {
  return (usage.input_tokens * PRICE.input) + (usage.output_tokens * PRICE.output);
}

function fmtUsage(usage) {
  return {
    input:  usage.input_tokens,
    output: usage.output_tokens,
    cost:   parseFloat(calcCost(usage).toFixed(6)),
  };
}

// Session-level accumulator (resets on server restart)
const session = { input: 0, output: 0, cost: 0, calls: 0 };

function accumulate(usage) {
  session.input  += usage.input_tokens;
  session.output += usage.output_tokens;
  session.cost   += calcCost(usage);
  session.calls  += 1;
}

function sessionSnapshot() {
  return { input: session.input, output: session.output, cost: parseFloat(session.cost.toFixed(6)), calls: session.calls };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static('public'));

// Serve esbuild dist/ output for each project
app.use('/preview/:projectId/', (req, res, next) => {
  const proj = projects.get(req.params.projectId);
  if (!proj?.built) return res.status(404).send('Project not built yet.');
  express.static(path.join(proj.dir, 'dist'))(req, res, next);
});

app.post('/generate', async (req, res) => {
  const { requirements } = req.body;
  if (!requirements?.trim()) return res.status(400).json({ error: 'Requirements cannot be empty.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    send({ status: 'Claude is architecting your React project...' });
    const t0 = Date.now();

    const GEN_TOOLS = [{
      name: 'write_project_files',
      description: 'Write all files for the React TypeScript Vite project',
      input_schema: {
        type: 'object', required: ['files'],
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object', required: ['path', 'content', 'description'],
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                description: { type: 'string', description: 'One concise line: what this file contains/does' },
              },
            },
          },
        },
      },
    }];
    const GEN_MESSAGES = [{ role: 'user', content: `Create a complete React TypeScript Vite project for:\n\n${requirements}` }];

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: GEN_TOOLS,
      tool_choice: { type: 'tool', name: 'write_project_files' },
      messages: GEN_MESSAGES,
    });

    const genMs = Date.now() - t0;
    const genUsage = fmtUsage(response.usage);
    accumulate(response.usage);

    await logAICall({
      phase: 'generate',
      model: 'claude-sonnet-4-6',
      system: SYSTEM_PROMPT,
      messages: GEN_MESSAGES,
      tools: GEN_TOOLS,
      forcedTool: 'write_project_files',
      startMs: t0,
      response,
      tokens: { ...genUsage, ms: genMs },
    });

    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolBlock) { send({ error: 'Claude did not return project files. Try again.' }); return res.end(); }

    const rawFiles = toolBlock.input?.files ?? [];
    // Guard: only accept files under src/ with valid path + content.
    // Reject postcss.config.js, tailwind.config.js, tsconfig*, vite.config*, index.html —
    // those are managed by the server and must not be overwritten by AI output.
    const files = rawFiles.filter(
      (f) => typeof f?.path === 'string' && f.path.trim()
          && typeof f?.content === 'string'
          && f.path.startsWith('src/')
    );
    if (files.length === 0) { send({ error: 'Claude returned no valid files. Try again.' }); return res.end(); }
    send({ status: `Writing ${files.length} files...` });

    const stamp = Date.now();
    const projectId = `project-${stamp}`;
    const projectDir = path.join(GENERATED_DIR, projectId);
    await fs.mkdir(projectDir, { recursive: true });

    // Copy base config files
    await Promise.all(Object.keys(BASE_FILES).map((n) => fs.copyFile(path.join(BASE_DIR, n), path.join(projectDir, n))));
    await fs.symlink(path.join(BASE_DIR, 'node_modules'), path.join(projectDir, 'node_modules'), 'junction');

    // Write AI-generated src files
    for (const file of files) {
      const dest = path.join(projectDir, file.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, file.content, 'utf-8');
    }

    // Write fixed boilerplate (main.tsx, index.css) + save the manifest ("skill")
    await writeFixedFiles(projectDir);
    await saveManifest(projectDir, files);

    const allFiles = [...Object.keys(FIXED_FILES), ...files.map((f) => f.path)];
    projects.set(projectId, {
      id: projectId, dir: projectDir,
      files: allFiles,
      createdAt: stamp, built: false,
    });

    send({ status: 'Bundling with esbuild...' });
    const previewUrl = await buildWithEsbuild(projectId);

    send({ done: true, projectId, previewUrl, files: allFiles, tokens: { ...genUsage, ms: genMs, session: sessionSnapshot() } });
    res.end();
  } catch (err) {
    console.error('Generation error:', err);
    send({ error: err.message || 'Unknown error.' });
    res.end();
  }
});

app.get('/projects', (_req, res) => {
  const list = [...projects.values()].map((p) => ({
    id: p.id, files: p.files, createdAt: p.createdAt,
    built: p.built,
    previewUrl: p.built ? `/preview/${p.id}/` : null,
    deployedUrl: p.deployedUrl || null,
    githubUrl: p.githubUrl || null,
  }));
  res.json(list.sort((a, b) => b.createdAt - a.createdAt));
});

// Rebuild preview (re-run esbuild after manual file edits)
app.post('/projects/:id/start', async (req, res) => {
  const proj = projects.get(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found.' });
  try {
    const previewUrl = await buildWithEsbuild(req.params.id);
    res.json({ previewUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/projects/:id', (req, res) => {
  const proj = projects.get(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Not found.' });
  projects.delete(req.params.id);
  res.json({ ok: true });
});

// ─── Two-phase incremental update ──────────────────────────────────────────────
// Phase 1: read manifest → pick relevant files. Phase 2: read only those → edit them.

app.post('/projects/:id/update', async (req, res) => {
  const proj = projects.get(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found.' });
  const { instruction } = req.body;
  if (!instruction?.trim()) return res.status(400).json({ error: 'Instruction cannot be empty.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // ── Phase 1: select files ───────────────────────────────────────────────
    send({ status: 'Reading project map & choosing files to edit...' });
    const manifest = await loadManifest(proj);
    const tSelect = Date.now();

    const SEL_TOOLS = [{
      name: 'select_files',
      description: 'Choose the minimal set of files needed to make the change',
      input_schema: {
        type: 'object', required: ['paths', 'reason'],
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Relative file paths to open' },
          reason: { type: 'string', description: 'Brief why these files' },
        },
      },
    }];
    const SEL_MESSAGES = [{
      role: 'user',
      content: `Project manifest:\n${JSON.stringify(manifest, null, 2)}\n\nChange request:\n${instruction}`,
    }];

    const selectResp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SELECT_SYSTEM,
      tools: SEL_TOOLS,
      tool_choice: { type: 'tool', name: 'select_files' },
      messages: SEL_MESSAGES,
    });

    const selectMs    = Date.now() - tSelect;
    const selectUsage = fmtUsage(selectResp.usage);
    accumulate(selectResp.usage);

    await logAICall({
      phase: 'select_files',
      projectId: req.params.id,
      model: 'claude-sonnet-4-6',
      system: SELECT_SYSTEM,
      messages: SEL_MESSAGES,
      tools: SEL_TOOLS,
      forcedTool: 'select_files',
      startMs: tSelect,
      response: selectResp,
      tokens: { ...selectUsage, ms: selectMs },
    });

    const selBlock = selectResp.content.find((b) => b.type === 'tool_use');
    let selected = (selBlock?.input?.paths || []).filter(
      (p) => p !== 'src/main.tsx' && p !== 'src/index.css'
    );
    if (selected.length === 0) selected = ['src/App.tsx'];

    send({ status: `Reading ${selected.length} file(s): ${selected.join(', ')}` });

    // ── Read only the selected files ─────────────────────────────────────────
    const fileContents = [];
    for (const rel of selected) {
      try {
        const content = await fs.readFile(path.join(proj.dir, rel), 'utf-8');
        fileContents.push({ path: rel, content });
      } catch { /* new file — skip read */ }
    }

    // ── Phase 2: edit ────────────────────────────────────────────────────────
    send({ status: 'Applying changes...' });
    const tEdit = Date.now();

    const filesBlock = fileContents
      .map((f) => `=== ${f.path} ===\n${f.content}`)
      .join('\n\n');

    const EDIT_TOOLS = [{
      name: 'apply_edits',
      description: 'Return the complete new content for every file that changes',
      input_schema: {
        type: 'object', required: ['files', 'summary'],
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object', required: ['path', 'content', 'description'],
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
          summary: { type: 'string', description: 'One line describing what changed' },
        },
      },
    }];
    const EDIT_MESSAGES = [{
      role: 'user',
      content: `Current files:\n\n${filesBlock}\n\nProject manifest (for context):\n${JSON.stringify(manifest, null, 2)}\n\nChange request:\n${instruction}`,
    }];

    const editResp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: EDIT_SYSTEM,
      tools: EDIT_TOOLS,
      tool_choice: { type: 'tool', name: 'apply_edits' },
      messages: EDIT_MESSAGES,
    });

    const editMs    = Date.now() - tEdit;
    const editUsage = fmtUsage(editResp.usage);
    accumulate(editResp.usage);

    await logAICall({
      phase: 'apply_edits',
      projectId: req.params.id,
      model: 'claude-sonnet-4-6',
      system: EDIT_SYSTEM,
      messages: EDIT_MESSAGES,
      tools: EDIT_TOOLS,
      forcedTool: 'apply_edits',
      startMs: tEdit,
      response: editResp,
      tokens: { ...editUsage, ms: editMs },
    });

    const editBlock = editResp.content.find((b) => b.type === 'tool_use');
    if (!editBlock) { send({ error: 'Claude returned no edits. Try rephrasing.' }); return res.end(); }

    const changed = (editBlock.input?.files ?? []).filter(
      (f) => typeof f?.path === 'string' && f.path.trim()
          && typeof f?.content === 'string'
          && f.path.startsWith('src/')
    );
    send({ status: `Writing ${changed.length} updated file(s)...` });

    // ── Write changed files to disk ──────────────────────────────────────────
    for (const file of changed) {
      const dest = path.join(proj.dir, file.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, file.content, 'utf-8');
    }

    // ── Rebuild preview bundle ───────────────────────────────────────────────
    send({ status: 'Rebuilding preview...' });
    await buildWithEsbuild(req.params.id);

    // ── Refresh manifest ─────────────────────────────────────────────────────
    const mfMap = new Map(manifest.files.map((f) => [f.path, f.description]));
    for (const f of changed) mfMap.set(f.path, f.description || mfMap.get(f.path) || '');
    const mergedEntries = [...mfMap.entries()]
      .filter(([p]) => p !== 'src/main.tsx' && p !== 'src/index.css')
      .map(([p, description]) => ({ path: p, description }));
    await saveManifest(proj.dir, mergedEntries);

    // Update in-memory file list with any newly created files
    const knownFiles = new Set(proj.files);
    for (const f of changed) knownFiles.add(f.path);
    proj.files = [...knownFiles];

    const tokens = {
      select: { ...selectUsage, ms: selectMs },
      edit:   { ...editUsage,   ms: editMs },
      total: {
        input:  selectUsage.input  + editUsage.input,
        output: selectUsage.output + editUsage.output,
        cost:   parseFloat((selectUsage.cost + editUsage.cost).toFixed(6)),
        ms:     selectMs + editMs,
      },
      session: sessionSnapshot(),
    };

    send({
      done: true,
      summary: editBlock.input.summary || 'Updated.',
      selected,
      changed: changed.map((f) => f.path),
      files: proj.files,
      tokens,
    });
    res.end();
  } catch (err) {
    console.error('Update error:', err);
    send({ error: err.message || 'Unknown error.' });
    res.end();
  }
});

app.get('/session', (_req, res) => res.json(sessionSnapshot()));

// ─── Logs endpoint ────────────────────────────────────────────────────────────
// Returns the last N AI call log entries (newest first).
app.get('/logs', (_req, res) => res.json(getCallLog()));

app.delete('/logs', async (_req, res) => {
  try { await fs.writeFile(LOG_FILE, '', 'utf-8'); } catch {}
  res.json({ ok: true });
});

app.get('/projects/:id/file', async (req, res) => {
  const proj = projects.get(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Not found.' });
  try {
    const content = await fs.readFile(path.join(proj.dir, req.query.path), 'utf-8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(content);
  } catch { res.status(404).send('File not found'); }
});

// ─── Deploy endpoint ──────────────────────────────────────────────────────────
// Pushes source to GitHub then deploys dist/ to Cloudflare Pages.

app.post('/projects/:id/deploy', async (req, res) => {
  const proj = projects.get(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found.' });
  if (!proj.built) return res.status(400).json({ error: 'Build the preview first.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    send({ status: 'Creating GitHub repository...' });
    const { cloneUrl, htmlUrl, fullName } = await createGitHubRepo(req.params.id);

    send({ status: 'Pushing source files to GitHub...' });
    await pushToGitHub(proj.dir, cloneUrl, req.params.id);

    send({ status: 'Deploying to Cloudflare Pages...' });
    const deployedUrl = await deployToCloudflarePages(path.join(proj.dir, 'dist'), req.params.id, fullName);

    Object.assign(proj, { deployedUrl, githubUrl: htmlUrl });
    send({ done: true, deployedUrl, githubUrl: htmlUrl });
    res.end();
  } catch (err) {
    console.error('[deploy] error:', err);
    send({ error: err.message || 'Deploy failed.' });
    res.end();
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
ensureLogDir()
  .then(ensureBase)
  .then(scanExistingProjects)
  .then(() => app.listen(PORT, () => console.log(`\nFrontend POC → http://localhost:${PORT}\n`)))
  .catch((err) => { console.error('Fatal:', err); process.exit(1); });
