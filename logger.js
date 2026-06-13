/**
 * AI call logger — tracks every request sent to Claude and its response.
 * Captures: model, system prompt, messages, tools, tool called, tokens, timing.
 *
 * Console: colored, human-readable per-call block
 * File:    logs/calls.jsonl — one JSON object per line (append-only)
 * Memory:  last 200 calls accessible via getCallLog() → GET /logs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const LOG_DIR  = path.join(__dirname, 'logs');
export const LOG_FILE = path.join(LOG_DIR, 'calls.jsonl');
const MAX_IN_MEMORY = 200;

// In-memory ring buffer — last 200 call entries
const callLog = [];

// ─── Terminal color codes (no external deps) ──────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  red:     '\x1b[31m',
  gray:    '\x1b[90m',
  white:   '\x1b[37m',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function trunc(val, n = 120) {
  const str = typeof val === 'string' ? val : JSON.stringify(val) ?? '';
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtNum(n) {
  return n?.toLocaleString() ?? '0';
}

function fmtCost(c) {
  return `$${c?.toFixed(6) ?? '0.000000'}`;
}

export async function ensureLogDir() {
  try { await fs.mkdir(LOG_DIR, { recursive: true }); } catch {}
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Log one Claude API call.
 *
 * @param {object} opts
 * @param {string}  opts.phase       - e.g. 'generate', 'select_files', 'apply_edits'
 * @param {string}  [opts.projectId] - project context label
 * @param {string}  opts.model
 * @param {string}  [opts.system]    - system prompt text
 * @param {Array}   opts.messages    - messages[] sent in the request
 * @param {Array}   [opts.tools]     - tools[] sent in the request
 * @param {string}  [opts.forcedTool]- name of the forced tool (tool_choice.name)
 * @param {number}  opts.startMs     - Date.now() captured before the API call
 * @param {object}  opts.response    - full Anthropic API response object
 * @param {object}  opts.tokens      - { input, output, cost } (already formatted)
 */
export async function logAICall({
  phase, projectId, model,
  system, messages = [], tools = [], forcedTool,
  startMs, response, tokens,
}) {
  const durationMs = Date.now() - startMs;

  // Extract the tool call from the response content
  const toolBlock = response?.content?.find(b => b.type === 'tool_use');
  const toolName   = toolBlock?.name ?? null;

  // Summarize tool input in a phase-specific way
  let toolSummary = null;
  if (toolBlock?.input) {
    if (phase === 'generate' || phase === 'apply_edits') {
      const files = toolBlock.input.files ?? [];
      toolSummary = `${files.length} file(s): ${files.map(f => f.path).join(', ')}`;
    } else if (phase === 'select_files') {
      const paths = toolBlock.input.paths ?? [];
      toolSummary = `selected: ${paths.join(', ')} — ${toolBlock.input.reason ?? ''}`;
    } else {
      toolSummary = trunc(JSON.stringify(toolBlock.input), 200);
    }
  }

  const entry = {
    id:          `call-${startMs}`,
    phase,
    projectId:   projectId ?? null,
    model,
    at:          new Date(startMs).toISOString(),
    durationMs,
    tokens:      tokens ?? null,
    request: {
      systemLen:     system?.length ?? 0,
      messageCount:  messages.length,
      messages:      messages.map(m => ({
        role:    m.role,
        preview: trunc(typeof m.content === 'string' ? m.content : JSON.stringify(m.content), 200),
      })),
      tools:      tools.map(t => t.name),
      forcedTool: forcedTool ?? null,
    },
    response: {
      stopReason:   response?.stop_reason ?? null,
      toolCalled:   toolName,
      toolSummary,
    },
  };

  // ── In-memory ring buffer ──────────────────────────────────────────────────
  callLog.push(entry);
  if (callLog.length > MAX_IN_MEMORY) callLog.shift();

  // ── Write to JSONL log file ────────────────────────────────────────────────
  try {
    await fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch { /* non-fatal */ }

  // ── Pretty console output ─────────────────────────────────────────────────
  const bar  = '─'.repeat(68);
  const half = '─'.repeat(30);

  // Header
  const phLabel = phase.toUpperCase().padEnd(16);
  const projLabel = projectId ? ` ${C.gray}[${projectId}]${C.reset}` : '';
  console.log(`\n${C.gray}${ts()}${C.reset}  ${C.bold}${C.cyan}${phLabel}${C.reset}${projLabel}`);
  console.log(`${C.gray}${bar}${C.reset}`);

  // ── What we sent to AI ────────────────────────────────────────────────────
  console.log(`${C.blue}${C.bold}→ SEND TO AI${C.reset}`);
  console.log(`  ${C.dim}Model   :${C.reset} ${C.white}${model}${C.reset}`);

  if (system) {
    console.log(`  ${C.dim}System  :${C.reset} ${C.gray}${trunc(system.replace(/\n+/g, ' '), 100)}${C.reset}`);
  }

  for (const m of messages) {
    const preview = trunc(
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      140
    );
    const roleColor = m.role === 'user' ? C.green : C.yellow;
    console.log(`  ${C.dim}Msg[${roleColor}${m.role}${C.reset}${C.dim}] :${C.reset} ${C.gray}${preview}${C.reset}`);
  }

  if (tools.length > 0) {
    const toolNames = tools.map(t => t.name).join(', ');
    const forced = forcedTool ? ` ${C.yellow}(forced: ${forcedTool})${C.reset}` : '';
    console.log(`  ${C.dim}Tools   :${C.reset} ${toolNames}${forced}`);
  }

  // ── What AI responded with ────────────────────────────────────────────────
  console.log(`${C.green}${C.bold}← AI RESPONSE${C.reset}  ${C.yellow}${fmtMs(durationMs)}${C.reset}`);

  if (toolName) {
    console.log(`  ${C.dim}Tool    :${C.reset} ${C.yellow}${C.bold}${toolName}${C.reset}`);
  }
  if (toolSummary) {
    console.log(`  ${C.dim}Result  :${C.reset} ${C.gray}${toolSummary}${C.reset}`);
  }

  const stop = response?.stop_reason ?? 'unknown';
  const stopColor = stop === 'tool_use' ? C.green : stop === 'end_turn' ? C.cyan : C.red;
  console.log(`  ${C.dim}Stop    :${C.reset} ${stopColor}${stop}${C.reset}`);

  // ── Token + cost summary ──────────────────────────────────────────────────
  if (tokens) {
    console.log(`${C.magenta}${C.bold}◆ TOKENS${C.reset}   in=${C.blue}${fmtNum(tokens.input)}${C.reset}  out=${C.green}${fmtNum(tokens.output)}${C.reset}  cost=${C.yellow}${fmtCost(tokens.cost)}${C.reset}  time=${C.white}${fmtMs(durationMs)}${C.reset}`);
  }

  console.log(`${C.gray}${bar}${C.reset}\n`);

  return entry;
}

/**
 * Log a non-AI step (e.g. "Writing 8 files", "Starting Vite").
 * Lightweight — only goes to console, not the log file.
 */
export function logStep(phase, projectId, message, extraMs) {
  const proj = projectId ? ` ${C.gray}[${projectId}]${C.reset}` : '';
  const time = extraMs != null ? `  ${C.gray}${fmtMs(extraMs)}${C.reset}` : '';
  console.log(`${C.gray}${ts()}${C.reset}  ${C.dim}${phase}${C.reset}${proj}  ${message}${time}`);
}

/** Return all in-memory log entries (newest-first). */
export function getCallLog() {
  return [...callLog].reverse();
}
