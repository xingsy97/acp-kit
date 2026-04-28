import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectInstalledAgents, isCommandOnPath } from '@acp-kit/core';
import { createLoopEngine, PaneStatus, Phase } from '../engine.mjs';
import { applyRoleSelection } from '../cli/config.mjs';
import { agentChoices, defaultModelForAgent, modelChoicesForAgent } from '../config/agents.mjs';
import { writePreferences } from '../config/preferences.mjs';

const DEFAULT_EDITOR_TIMEOUT_MS = 30 * 60 * 1000;
const ENGINE_RENDER_FRAME_MS = 80;
const TUI_STATIC_STATUS_MARK = '•';
const TUI_SPINNER_FRAMES = ['-', '\\', '|', '/'];
const TUI_SCAN_FRAMES = ['▰▱▱▱▱▱', '▰▰▱▱▱▱', '▱▰▰▱▱▱', '▱▱▰▰▱▱', '▱▱▱▰▰▱', '▱▱▱▱▰▰', '▱▱▱▱▱▰'];
const TUI_PROGRESS_FRAMES = ['▰▱▱▱▱▱▱▱', '▰▰▱▱▱▱▱▱', '▱▰▰▱▱▱▱▱', '▱▱▰▰▱▱▱▱', '▱▱▱▰▰▱▱▱', '▱▱▱▱▰▰▱▱', '▱▱▱▱▱▰▰▱', '▱▱▱▱▱▱▰▰'];
const FINISH_ANIMATION_FRAME_MS = 80;
const FINISH_ANIMATION_FRAMES = 18;

export function parseEditorCommand(raw, { platform = process.platform } = {}) {
  const parsed = splitCommandLine(String(raw ?? '').trim(), { platform });
  if (parsed.length === 0) return { command: String(raw ?? '').trim(), args: [] };
  return { command: parsed[0], args: parsed.slice(1) };
}

export function splitCommandLine(value, { platform = process.platform } = {}) {
  const parts = [];
  let current = '';
  let quote = null;
  let escaping = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (platform !== 'win32' && char === '\\' && quote !== "'" && shouldEscapeNext(value[index + 1])) {
      escaping = true;
      continue;
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += '\\';
  if (current) parts.push(current);
  return parts;
}

function shouldEscapeNext(char) {
  return char === '\\' || char === '"' || char === "'" || /\s/.test(char || '');
}

export function commitSetupSelections(config, setup, { savePreferences = writePreferences } = {}) {
  applyRoleSelection(config, {
    author: {
      agentId: config.authorSettings.agentSource === 'env' ? config.authorSettings.agentId : setup.selections.authorAgentId,
      model: config.authorSettings.modelSource === 'env' ? config.authorSettings.model : setup.selections.authorModel,
      agentSource: config.authorSettings.agentSource === 'env' ? 'env' : 'tui',
      modelSource: config.authorSettings.modelSource === 'env' ? 'env' : 'tui',
    },
    reviewer: {
      agentId: config.reviewerSettings.agentSource === 'env' ? config.reviewerSettings.agentId : setup.selections.reviewerAgentId,
      model: config.reviewerSettings.modelSource === 'env' ? config.reviewerSettings.model : setup.selections.reviewerModel,
      agentSource: config.reviewerSettings.agentSource === 'env' ? 'env' : 'tui',
      modelSource: config.reviewerSettings.modelSource === 'env' ? 'env' : 'tui',
    },
  });

  if (!setup.selections.save) return;
  savePreferences({
    author: {
      agent: setup.selections.authorAgentId,
      model: setup.selections.authorModel,
    },
    reviewer: {
      agent: setup.selections.reviewerAgentId,
      model: setup.selections.reviewerModel,
    },
  }, {
    filePath: config.preferencesPath,
  });
}

/**
 * Ink-based TUI renderer.
 *
 * Design principles (the previous implementation violated all three):
 *   1. The TUI must always occupy exactly the visible terminal viewport.
 *      We pin the root <Box> to `stdout.rows` x `stdout.columns` so Ink
 *      never lays out beyond the screen edges.
 *   2. Content must NEVER overflow off-screen. Every container uses
 *      `overflow="hidden"`. Each pane has a fixed height computed from the
 *      remaining viewport budget; long pane content is scrolled internally
 *      via a per-pane scroll offset rather than by growing the layout.
 *   3. The TUI uses the alternate screen buffer (\x1b[?1049h / l) so it
 *      owns the screen for the duration of the run and leaves the user's
 *      scrollback intact when it exits.
 *
 * Lazy-imports `ink` and `react` so the plain CLI does not pay for them.
 * Returns 0 on approval, 1 otherwise.
 */
export async function runTui({ config }) {
  let ink;
  let React;
  try {
    [ink, React] = await Promise.all([import('ink'), import('react')]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      'Ink TUI mode requires the optional `ink` and `react` packages.\n'
        + `Install them or rerun with --cli.\nUnderlying error: ${detail}`,
    );
  }

  const { render, Box, Text, useApp, useInput, useStdout } = ink;
  const {
    createElement: h,
    useEffect,
    useState,
    useReducer,
  } = React;

  let approvalResolver = null;
  let exitAfterApproval = false;
  let approvalBellRung = false;
  config.onApproved = () => new Promise((resolve) => {
    approvalResolver = resolve;
  });

  function resolveApproval(decision) {
    if (decision?.continue) approvalBellRung = false;
    const resolve = approvalResolver;
    approvalResolver = null;
    resolve?.(decision);
  }

  function forceContinueAfterApproval() {
    resolveApproval({
      continue: true,
      feedback: `The reviewer approved, but the user requested another round. Re-check the current task and make any further improvements needed:\n${config.task}`,
    });
  }

  let engine = null;

  // -- TTY guard -----------------------------------------------------------
  // The TUI requires a real terminal both to draw and to read confirmation;
  // refuse loudly on non-TTY before touching the screen so we never leave
  // half-rendered escape sequences in the user's pipeline output.
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error(
      '--tui requires an interactive terminal (stdin and stdout must be TTY).\n'
        + 'Re-run with --cli or attach a TTY.',
    );
  }

  // -- alt screen buffer ---------------------------------------------------
  let altScreenActive = false;
  function enterAltScreen() {
    if (!process.stdout.isTTY || altScreenActive) return;
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
    altScreenActive = true;
  }
  function leaveAltScreen() {
    if (!altScreenActive) return;
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    altScreenActive = false;
  }
  enterAltScreen();
  const restore = () => leaveAltScreen();
  const handleSigint = () => { restore(); process.exit(130); };
  const handleSigterm = () => { restore(); process.exit(143); };
  process.on('exit', restore);
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);

  // -- helpers -------------------------------------------------------------
  function paneStatusColor(status) {
    if (status === PaneStatus.Running) return 'yellow';
    if (status === PaneStatus.Completed) return 'green';
    if (status === PaneStatus.Failed) return 'red';
    return 'gray';
  }

  function toolStatusColor(status) {
    if (status === 'partial-failed') return '#ffa500';
    if (status === 'failed' || status === 'error') return 'red';
    if (status === 'completed' || status === 'done' || status === 'success') return 'green';
    return 'yellow';
  }

  function toolStatusLabel(status) {
    return status === 'completed' ? 'done' : status;
  }

  function line(child, key) {
    return h(Box, { key, height: 1, overflow: 'hidden' }, child);
  }

  function rowText(text, key) {
    return line(h(Text, { wrap: 'truncate-end' }, text), key);
  }

  function muted(text) {
    return h(Text, { dimColor: true }, text);
  }

  function shortcutLabel(text, color = 'cyan') {
    return h(Text, { color, bold: true }, text);
  }

  function shortcutLine(...parts) {
    return h(Text, { wrap: 'truncate-end' }, ...parts);
  }

  function normalizeDisplayText(text) {
    return text.replace(/([.!?])(?=[A-Z`])/g, '$1 ');
  }

  function stringifyValue(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    const seen = new WeakSet();
    return JSON.stringify(value, (key, item) => {
      if (typeof item === 'bigint') return String(item);
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }) || '';
  }

  function compactWhitespace(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function truncateText(text, max) {
    const value = compactWhitespace(text);
    return fitText(value, max, { ellipsis: true }).text;
  }

  function fitText(text, width, { ellipsis = false } = {}) {
    const safeWidth = Math.max(0, width);
    const value = String(text ?? '');
    if (safeWidth === 0) return { text: '', width: 0 };
    const target = ellipsis ? Math.max(0, safeWidth - 1) : safeWidth;
    let used = 0;
    let result = '';
    for (const char of value) {
      const charWidth = displayWidth(char);
      if (used + charWidth > target) break;
      result += char;
      used += charWidth;
    }
    if (ellipsis && used < displayWidth(value)) {
      result += '\u2026';
      used += 1;
    }
    return { text: result, width: used };
  }

  function displayWidth(text) {
    let width = 0;
    for (const char of String(text ?? '')) width += displayCharWidth(char);
    return width;
  }

  function displayCharWidth(char) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0) return 0;
    if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
    if ((code >= 0x0300 && code <= 0x036f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
    if (
      code >= 0x1100 && (
        code <= 0x115f
        || code === 0x2329
        || code === 0x232a
        || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
        || (code >= 0xac00 && code <= 0xd7a3)
        || (code >= 0xf900 && code <= 0xfaff)
        || (code >= 0xfe10 && code <= 0xfe19)
        || (code >= 0xfe30 && code <= 0xfe6f)
        || (code >= 0xff00 && code <= 0xff60)
        || (code >= 0xffe0 && code <= 0xffe6)
        || (code >= 0x1f300 && code <= 0x1faff)
      )
    ) return 2;
    return 1;
  }

  function firstLine(text) {
    return String(text || '').split('\n')[0] || '';
  }

  function taskSummary(task) {
    const summary = compactWhitespace(String(task || '(empty)'));
    return summary || '(empty)';
  }

  function taskPreviewRows(task, cols, { prefix = 'task:     ', maxRows = 2 } = {}) {
    const safeCols = Math.max(1, cols);
    const rows = wrapLine(`${prefix}${taskSummary(task)}`, safeCols);
    if (rows.length <= maxRows) return { rows, truncated: false };
    const hint = ' … [v view full task]';
    const visible = rows.slice(0, maxRows);
    const lastIndex = visible.length - 1;
    const room = Math.max(1, safeCols - hint.length);
    visible[lastIndex] = `${visible[lastIndex].slice(0, room).trimEnd()}${hint}`;
    return { rows: visible, truncated: true };
  }

  function fixedTaskPreviewRows(task, cols, options = {}) {
    const { rows, truncated } = taskPreviewRows(task, cols, options);
    const maxRows = options.maxRows ?? 2;
    const padded = rows.slice(0, maxRows);
    while (padded.length < maxRows) padded.push('');
    return { rows: padded, truncated };
  }

  function ensureEngine() {
    if (!engine) engine = createLoopEngine({ config });
    return engine;
  }

  function configuredAgentsAvailable() {
    if (!config.authorSettings.agent || !config.reviewerSettings.agent) return [];
    const agentsToCheck = [config.authorSettings.agent, config.reviewerSettings.agent];
    const unique = [...new Map(agentsToCheck.map((a) => [a.id, a])).values()];
    return detectInstalledAgents(unique).filter((r) => !r.installed);
  }

  function formatMissingAgentError(missing) {
    return [
      ...missing.map(({ agent }) =>
        `agent "${agent.displayName}" is not available - neither "${agent.command}" nor any fallback command was found on PATH.`),
      'Install the missing agent(s) or pick a different installed agent.',
    ].join('\n');
  }

  function agentName(settings) {
    return settings.agent?.displayName ?? '(choose)';
  }

  function agentSummary(settings) {
    return settings.agent
      ? `${settings.agent.displayName} (${settings.agent.id})`
      : '(choose)';
  }

  function createEmptyEngineState() {
    return {
      phase: Phase.Idle,
      order: [],
      rounds: new Map(),
      statuses: { AUTHOR: 'launching', REVIEWER: 'launching' },
      trace: [],
      result: null,
      error: null,
    };
  }

  function findField(value, names, depth = 0) {
    if (value == null || depth > 4) return '';
    if (typeof value === 'string') return '';
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findField(item, names, depth + 1);
        if (found) return found;
      }
      return '';
    }
    if (typeof value !== 'object') return '';
    for (const [key, item] of Object.entries(value)) {
      if (names.includes(key) && (typeof item === 'string' || typeof item === 'number')) {
        return String(item);
      }
    }
    for (const item of Object.values(value)) {
      const found = findField(item, names, depth + 1);
      if (found) return found;
    }
    return '';
  }

  function summarizeValue(value, max = 90) {
    if (value == null) return '';
    const command = findField(value, ['command', 'cmd', 'shellCommand', 'script']);
    if (command) return truncateText(command, max);
    const text = stringifyValue(value);
    return truncateText(text, max);
  }

  function summarizeTool(item, { compact = false } = {}) {
    const status = toolStatusLabel(item.status || 'running');
    const title = item.title || item.name || item.toolCallId || 'tool';
    const input = summarizeValue(item.input, compact ? 44 : 80);
    const output = summarizeValue(item.output, compact ? 36 : 70);
    const parts = [`${item.tag || '#?'} ${status}`, title];
    if (input) parts.push(`cmd: ${input}`);
    if (output) parts.push(`out: ${output}`);
    if (item.chars) parts.push(`${item.chars} chars`);
    return parts.join(' - ');
  }

  function mergedToolStatus(items) {
    const failed = items.filter((item) => item.status === 'failed' || item.status === 'error').length;
    if (failed === items.length) return 'failed';
    if (failed > 0) return 'partial-failed';
    if (items.some((item) => item.status === 'running')) return 'running';
    return items[items.length - 1]?.status || 'completed';
  }

  // Two distinct numbers can arrive for one role:
  //   * inputTokens / outputTokens are CUMULATIVE session totals reported by
  //     ACP `PromptResponse.usage` (sum across all turns so far).
  //   * used / size are a CONTEXT-WINDOW snapshot reported by ACP
  //     `usage_update` (tokens currently in context vs. context window size).
  // Show whichever is available; show both when both are.
  function formatUsage(usage) {
    const parts = [];
    const used = Number.isFinite(usage?.used) ? usage.used : 0;
    const size = Number.isFinite(usage?.size) ? usage.size : 0;
    if (used > 0 || size > 0) {
      parts.push(`ctx ${formatTokenCount(used)}/${formatTokenCount(size)} Tk`);
    }
    const input = Number.isFinite(usage?.inputTokens) ? usage.inputTokens : 0;
    const output = Number.isFinite(usage?.outputTokens) ? usage.outputTokens : 0;
    if (input > 0 || output > 0) {
      parts.push(`\u03A3 in:${formatTokenCount(input)} out:${formatTokenCount(output)}`);
    }
    if (parts.length === 0) return 'Tokens --';
    return parts.join(' \u00B7 ');
  }

  function formatTokenCount(tokens) {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.?0+$/, '')}K`;
    return String(tokens);
  }

  function formatDuration(durationMs) {
    if (!Number.isFinite(durationMs)) return 'time --';
    if (durationMs < 1000) return `time ${Math.max(0, Math.round(durationMs))}ms`;
    const seconds = durationMs / 1000;
    if (seconds < 60) return `time ${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return `time ${minutes}m${String(rest).padStart(2, '0')}s`;
  }

  function paneElapsedMs(pane) {
    if (!pane) return null;
    if (Number.isFinite(pane.durationMs)) return pane.durationMs;
    if (Number.isFinite(pane.startedAt)) {
      const end = Number.isFinite(pane.finishedAt) ? pane.finishedAt : Date.now();
      return Math.max(0, end - pane.startedAt);
    }
    return null;
  }

  // Soft-wrap one logical line to display rows. Prefer word boundaries; only
  // hard-cut when a single token is wider than the pane.
  function wrapLine(line, cols) {
    if (cols <= 0) return [line];
    if (displayWidth(line) <= cols) return [line];
    const out = [];
    let rest = line;
    while (displayWidth(rest) > cols) {
      let cut = fitText(rest, cols).text.length;
      let wordCut = rest.lastIndexOf(' ', cut);
      while (wordCut > 0 && displayWidth(rest.slice(0, wordCut)) > cols) {
        wordCut = rest.lastIndexOf(' ', wordCut - 1);
      }
      if (wordCut > 0) cut = wordCut;
      if (cut <= 0) cut = 1;
      out.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    if (rest) out.push(rest);
    return out;
  }

  function editorCommand() {
    const raw = process.env.VISUAL || process.env.EDITOR;
    if (raw && raw.trim()) return parseEditorCommand(raw);
    if (process.platform === 'win32') return { command: 'notepad.exe', args: [] };
    return { command: 'vi', args: [] };
  }

  function editorTimeoutMs() {
    const parsed = Number.parseInt(process.env.ACP_REVIEW_EDITOR_TIMEOUT_MS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EDITOR_TIMEOUT_MS;
  }

  function editTaskText(currentTask) {
    let tempDir;
    let previousRawMode = process.stdin.isRaw;
    let terminalReleased = false;
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-task-'));
      const taskFile = path.join(tempDir, 'task.txt');
      fs.writeFileSync(taskFile, currentTask || '', 'utf8');
      const { command, args } = editorCommand();
      const timeout = editorTimeoutMs();
      leaveAltScreen();
      terminalReleased = true;
      previousRawMode = process.stdin.isRaw;
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      const result = spawnSync(command, [...args, taskFile], { stdio: 'inherit', timeout });
      if (result.error) {
        if (result.error.code === 'ETIMEDOUT') {
          throw new Error(`${command} timed out after ${Math.round(timeout / 1000)} seconds.`);
        }
        throw result.error;
      }
      if (result.signal) throw new Error(`${command} exited after signal ${result.signal}.`);
      if (result.status && result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
      return fs.readFileSync(taskFile, 'utf8').trimEnd();
    } finally {
      try {
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      } finally {
        if (terminalReleased) {
          if (process.stdin.setRawMode) process.stdin.setRawMode(Boolean(previousRawMode));
          enterAltScreen();
        }
      }
    }
  }

  const agentIdByProfileId = new Map(agentChoices.map(({ id, agent }) => [agent.id, id]));

  const userCliCommands = Object.freeze({
    claude: ['claude'],
    codex: ['codex'],
    copilot: ['copilot-language-server', 'copilot'],
    gemini: ['gemini'],
    opencode: ['opencode'],
    qwen: ['qwen'],
  });

  // Startup UI separates user CLI installation from ACP launch capability.
  // Users care whether their normal CLI is present; launch fallback details are
  // internal and are summarized as Ready / Will prepare / Unavailable.
  function agentAvailability(agent) {
    const commandFound = isCommandOnPath(agent.command);
    const fallbackFound = (agent.fallbackCommands ?? []).some((fallback) => isCommandOnPath(fallback.command));
    if (commandFound) return { status: 'ready', launchKind: 'local', commandFound, fallbackFound };
    if (fallbackFound) return { status: 'auto', launchKind: 'fallback', commandFound, fallbackFound };
    return { status: 'unavailable', launchKind: 'none', commandFound, fallbackFound };
  }

  const availabilityByAgentId = new Map(agentChoices.map(({ id, agent }) => [id, agentAvailability(agent)]));
  const userCliByAgentId = new Map(agentChoices.map(({ id }) => [
    id,
    (userCliCommands[id] ?? []).some((command) => isCommandOnPath(command)),
  ]));

  function agentOptions() {
    return agentChoices.map(({ id, agent }) => {
      const availability = availabilityByAgentId.get(id) ?? { status: 'unavailable' };
      return {
        id,
        agent,
        label: agent.displayName,
        availability,
        userCliFound: userCliByAgentId.get(id) ?? false,
        disabled: availability.status === 'unavailable',
      };
    });
  }

  function launchableAgentOptions() {
    return agentOptions().filter((option) => !option.disabled);
  }

  function firstLaunchableAgentId(preferredId) {
    const options = launchableAgentOptions();
    if (options.some((option) => option.id === preferredId)) return preferredId;
    return options.find((option) => option.availability.status === 'ready')?.id ?? options[0]?.id;
  }

  function selectableIndex(options, preferredId) {
    const preferred = options.findIndex((option) => option.id === preferredId && !option.disabled);
    if (preferred >= 0) return preferred;
    return Math.max(0, options.findIndex((option) => !option.disabled));
  }

  function createInitialSetupState() {
    const configuredAuthorAgentId = config.authorSettings.agentId
      ?? agentIdByProfileId.get(config.authorSettings.agent?.id);
    const configuredReviewerAgentId = config.reviewerSettings.agentId
      ?? agentIdByProfileId.get(config.reviewerSettings.agent?.id);
    const authorAgentId = config.authorSettings.agentSource === 'env'
      ? configuredAuthorAgentId
      : firstLaunchableAgentId(configuredAuthorAgentId ?? 'copilot');
    const reviewerAgentId = config.reviewerSettings.agentSource === 'env'
      ? configuredReviewerAgentId
      : firstLaunchableAgentId(configuredReviewerAgentId ?? 'codex');
    const required = !configuredAuthorAgentId
      || !configuredReviewerAgentId
      || availabilityByAgentId.get(configuredAuthorAgentId)?.status === 'unavailable'
      || availabilityByAgentId.get(configuredReviewerAgentId)?.status === 'unavailable'
      || config.authorSettings.model === undefined
      || config.reviewerSettings.model === undefined;
    const setup = {
      required,
      mode: 'summary',
      activeRole: 'author',
      cursor: 0,
      error: null,
      selections: {
        authorAgentId,
        authorModel: config.authorSettings.model === undefined ? defaultModelForAgent(authorAgentId) : config.authorSettings.model,
        reviewerAgentId,
        reviewerModel: config.reviewerSettings.model === undefined ? defaultModelForAgent(reviewerAgentId) : config.reviewerSettings.model,
        save: true,
      },
    };
    setup.cursor = defaultCursorForStep(setup);
    return setup;
  }

  function setupStepOptions(setup) {
    const mode = setup.mode;
    if (mode === 'model') {
      const role = setup.activeRole;
      const agentId = setup.selections[`${role}AgentId`];
      const current = setup.selections[`${role}Model`];
      return modelChoicesForAgent(agentId, current).map((choice) => ({
        id: choice.id,
        label: choice.label,
        value: choice.value,
        disabled: false,
      }));
    }
    return [];
  }

  function defaultCursorForStep(setup) {
    if (setup.mode === 'summary') {
      const options = agentOptions();
      return selectableIndex(options, setup.selections[`${setup.activeRole}AgentId`]);
    }
    const options = setupStepOptions(setup);
    if (setup.mode === 'model') {
      const role = setup.activeRole;
      const current = setup.selections[`${role}Model`];
      const idx = options.findIndex((option) => option.value === current);
      return idx >= 0 ? idx : 0;
    }
    return 0;
  }

  function advanceSetup(setup) {
    if (setup.mode === 'summary') return finishSetup(setup);

    const options = setupStepOptions(setup);
    const option = options[setup.cursor];
    if (!option || option.disabled) {
      return { ...setup, error: option ? `${option.label} is unavailable.` : 'No selectable option.' };
    }

    const selections = { ...setup.selections };
    if (setup.mode === 'model') {
      const role = setup.activeRole;
      selections[`${role}Model`] = option.value;
    }

    const next = { ...setup, mode: 'summary', selections, error: null };
    return { ...next, cursor: defaultCursorForStep(next) };
  }

  function finishSetup(setup) {
    if (!setup.selections.authorAgentId || !setup.selections.reviewerAgentId) {
      return { ...setup, error: 'No launchable AUTHOR/REVIEWER agent is selectable.' };
    }
    const authorAvailability = availabilityByAgentId.get(setup.selections.authorAgentId)?.status;
    const reviewerAvailability = availabilityByAgentId.get(setup.selections.reviewerAgentId)?.status;
    if (authorAvailability === 'unavailable' || reviewerAvailability === 'unavailable') {
      return { ...setup, error: 'Selected AUTHOR/REVIEWER agent is unavailable.' };
    }
    return { ...setup, done: true, error: null };
  }

  function moveSetupCursor(setup, delta) {
    const options = setup.mode === 'summary' ? agentOptions() : setupStepOptions(setup);
    if (options.length === 0) return setup;
    let next = setup.cursor;
    for (let i = 0; i < options.length; i += 1) {
      next = (next + delta + options.length) % options.length;
      if (!options[next]?.disabled) break;
    }
    return { ...setup, cursor: next, error: null };
  }

  function backSetup(setup) {
    if (setup.mode === 'summary') return setup;
    return { ...setup, mode: 'summary', cursor: 0, error: null };
  }

  function enterModelMode(setup) {
    if (setup.activeRole === 'author' && config.authorSettings.modelSource === 'env') return { ...setup, error: 'AUTHOR_MODEL is set by environment.' };
    if (setup.activeRole === 'reviewer' && config.reviewerSettings.modelSource === 'env') return { ...setup, error: 'REVIEWER_MODEL is set by environment.' };
    const next = { ...setup, mode: 'model', error: null };
    return { ...next, cursor: defaultCursorForStep(next) };
  }

  function enterCustomModelMode(setup) {
    if (setup.activeRole === 'author' && config.authorSettings.modelSource === 'env') return { ...setup, error: 'AUTHOR_MODEL is set by environment.' };
    if (setup.activeRole === 'reviewer' && config.reviewerSettings.modelSource === 'env') return { ...setup, error: 'REVIEWER_MODEL is set by environment.' };
    const role = setup.activeRole;
    return {
      ...setup,
      mode: 'customModel',
      customModelInput: setup.selections[`${role}Model`] ?? '',
      cursor: 0,
      error: null,
    };
  }

  function updateCustomModelInput(setup, input) {
    return { ...setup, customModelInput: input, error: null };
  }

  function appendCustomModelInput(setup, input) {
    if (!input || /[\r\n\t]/.test(input)) return setup;
    return updateCustomModelInput(setup, `${setup.customModelInput ?? ''}${input}`);
  }

  function backspaceCustomModelInput(setup) {
    return updateCustomModelInput(setup, String(setup.customModelInput ?? '').slice(0, -1));
  }

  function applyCustomModelInput(setup) {
    const role = setup.activeRole;
    const raw = String(setup.customModelInput ?? '').trim();
    const next = {
      ...setup,
      mode: 'summary',
      selections: {
        ...setup.selections,
        [`${role}Model`]: raw || null,
      },
      customModelInput: '',
      error: null,
    };
    return { ...next, cursor: defaultCursorForStep(next) };
  }

  function toggleSetupRole(setup) {
    const next = { ...setup, activeRole: setup.activeRole === 'author' ? 'reviewer' : 'author', error: null };
    return { ...next, cursor: defaultCursorForStep(next) };
  }

  function assignSelectedAgent(setup) {
    const role = setup.activeRole;
    if (role === 'author' && config.authorSettings.agentSource === 'env') return { ...setup, error: 'AUTHOR_AGENT is set by environment.' };
    if (role === 'reviewer' && config.reviewerSettings.agentSource === 'env') return { ...setup, error: 'REVIEWER_AGENT is set by environment.' };
    const option = agentOptions()[setup.cursor];
    if (!option || option.disabled) return { ...setup, error: option ? `${option.label} is unavailable.` : 'No selectable agent.' };
    return {
      ...setup,
      selections: {
        ...setup.selections,
        [`${role}AgentId`]: option.id,
        [`${role}Model`]: defaultModelForAgent(option.id),
      },
      error: null,
    };
  }

  function toggleSetupSave(setup) {
    return { ...setup, selections: { ...setup.selections, save: !setup.selections.save }, error: null };
  }

  function agentDisplayName(agentId) {
    return agentChoices.find((choice) => choice.id === agentId)?.agent.displayName ?? '(choose)';
  }

  function availabilityLabel(availability) {
    if (availability?.status === 'ready') return 'Ready';
    if (availability?.status === 'auto') return 'Launch via npx';
    return 'Unavailable';
  }

  function userCliLabel(found) {
    return found ? 'Found' : 'Missing';
  }

  function userCliColor(found) {
    return found ? 'green' : 'red';
  }

  function setupModelLabel(agentId, model, userCliFound) {
    if (!userCliFound) return 'X';
    return model ?? '(agent default)';
  }

  function setupSourceLabel(setup, role) {
    const settings = role === 'author' ? config.authorSettings : config.reviewerSettings;
    if (settings.agentSource === 'env' || settings.modelSource === 'env') return 'env lock';
    if (setup.selections[`${role}AgentId`] !== settings.agentId || setup.selections[`${role}Model`] !== settings.model) return 'edited';
    if (settings.modelSource === 'tui' || settings.agentSource === 'tui') return 'tui';
    if (settings.modelSource === 'config' || settings.agentSource === 'config') return 'saved';
    if (settings.modelSource === 'default' || settings.agentSource === 'default') return 'default';
    return 'choose';
  }

  function setupSourceColor(setup, role) {
    const settings = role === 'author' ? config.authorSettings : config.reviewerSettings;
    if (settings.agentSource === 'env' || settings.modelSource === 'env') return 'yellow';
    if (setup.selections[`${role}AgentId`] !== settings.agentId || setup.selections[`${role}Model`] !== settings.model) return 'green';
    if (settings.modelSource === 'tui' || settings.agentSource === 'tui') return 'green';
    if (settings.modelSource === 'config' || settings.agentSource === 'config') return 'cyan';
    return 'gray';
  }

  function defaultModelLabel(option) {
    if (!option.userCliFound) return 'X';
    return defaultModelForAgent(option.id) ?? '(agent default)';
  }

  function availabilityColor(availability) {
    if (availability?.status === 'ready') return 'green';
    if (availability?.status === 'auto') return 'yellow';
    return 'gray';
  }

  function setupRoleStatus(setup, role) {
    return availabilityByAgentId.get(setup.selections[`${role}AgentId`]);
  }

  function setupRoleCliFound(setup, role) {
    return userCliByAgentId.get(setup.selections[`${role}AgentId`]) ?? false;
  }

  function padCell(value, width) {
    const fitted = fitText(String(value ?? '').replace(/\r/g, ''), width, { ellipsis: true });
    return fitted.text + ' '.repeat(Math.max(0, width - fitted.width));
  }

  function applySetupSelections(setup) {
    commitSetupSelections(config, setup);
  }

  const initialSetup = createInitialSetupState();

  // -- view state (separate from engine state) -----------------------------
  const initialView = {
    selected: null,    // round number currently focused
    follow: true,      // auto-jump to latest round
    focus: 'AUTHOR',   // which pane is active for scrolling
    screen: 'flow',     // flow | trace | tool | taskConfirm | finishing
    setup: initialSetup,
    awaitingSetup: !config.skipConfirm || initialSetup.required,
    selectedTool: null, // { round, role, toolCallId } used by the tool detail view
    pendingTask: null,
    editFromConfirm: false,
    editFromSetup: false,
    editingTask: false,
    editError: null,
    scrollAuthor: 0,   // 0 = bottom; positive = scrolled up by N lines
    scrollReviewer: 0,
    scrollTrace: 0,
    scrollTool: 0,
    scrollTask: 0,
    scrollError: 0,
    scrollConfirm: 0,
    wrap: true,        // soft wrap pane content
    showHelp: false,
    awaitingConfirm: false,
    cancelled: false,  // user pressed n/Esc on the confirm overlay
    finishFrame: 0,
  };
  function viewReducer(s, a) {
    switch (a.type) {
      case 'setupMove':
        return { ...s, setup: moveSetupCursor(s.setup, a.delta) };
      case 'setupBack':
        return { ...s, setup: backSetup(s.setup) };
      case 'setupModelMode':
        return { ...s, setup: enterModelMode(s.setup) };
      case 'setupCustomModelMode':
        return { ...s, setup: enterCustomModelMode(s.setup) };
      case 'setupCustomModelInput':
        return { ...s, setup: updateCustomModelInput(s.setup, a.input) };
      case 'setupCustomModelAppend':
        return { ...s, setup: appendCustomModelInput(s.setup, a.input) };
      case 'setupCustomModelBackspace':
        return { ...s, setup: backspaceCustomModelInput(s.setup) };
      case 'setupCustomModelApply':
        return { ...s, setup: applyCustomModelInput(s.setup) };
      case 'setupToggleRole':
        return { ...s, setup: toggleSetupRole(s.setup) };
      case 'setupAssignAgent':
        return { ...s, setup: assignSelectedAgent(s.setup) };
      case 'setupToggleSave':
        return { ...s, setup: toggleSetupSave(s.setup) };
      case 'setupChoose': {
        const setup = advanceSetup(s.setup);
        if (!setup.done) return { ...s, setup };
        try {
          applySetupSelections(setup);
          const missing = configuredAgentsAvailable();
          if (missing.length > 0) {
            return {
              ...s,
              setup: { ...setup, done: false, error: formatMissingAgentError(missing) },
            };
          }
          return { ...s, setup, awaitingSetup: false };
        } catch (error) {
          return {
            ...s,
            setup: {
              ...setup,
              done: false,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
      case 'confirm':
        return { ...s, awaitingConfirm: false };
      case 'cancel':
        return { ...s, awaitingSetup: false, awaitingConfirm: false, cancelled: true };
      case 'select': {
        if (a.order.length === 0) return s;
        const cur = s.selected ?? a.order[a.order.length - 1];
        const idx = Math.max(0, a.order.indexOf(cur));
        const next = Math.max(0, Math.min(a.order.length - 1, idx + a.delta));
        const sel = a.order[next];
        return {
          ...s,
          selected: sel,
          follow: sel === a.order[a.order.length - 1],
          scrollAuthor: 0,
          scrollReviewer: 0,
        };
      }
      case 'jumpLatest':
        if (a.order.length === 0) return s;
        return { ...s, selected: a.order[a.order.length - 1], follow: true, scrollAuthor: 0, scrollReviewer: 0 };
      case 'autoFollow':
        if (!s.follow || a.order.length === 0) return s;
        return { ...s, selected: a.order[a.order.length - 1] };
      case 'scroll': {
        const key = s.screen === 'trace'
          ? 'scrollTrace'
          : s.screen === 'error' ? 'scrollError'
          : s.screen === 'task' ? 'scrollTask'
          : s.screen === 'tool' ? 'scrollTool'
          : s.focus === 'AUTHOR' ? 'scrollAuthor' : 'scrollReviewer';
        const next = Math.max(0, s[key] + a.delta);
        return { ...s, [key]: next };
      }
      case 'scrollEnd': {
        const key = s.screen === 'trace'
          ? 'scrollTrace'
          : s.screen === 'error' ? 'scrollError'
          : s.screen === 'task' ? 'scrollTask'
          : s.screen === 'tool' ? 'scrollTool'
          : s.focus === 'AUTHOR' ? 'scrollAuthor' : 'scrollReviewer';
        return { ...s, [key]: 0 };
      }
      case 'scrollConfirm':
        return { ...s, scrollConfirm: Math.max(0, s.scrollConfirm + a.delta) };
      case 'scrollConfirmTop':
        return { ...s, scrollConfirm: 0 };
      case 'toggleTrace':
        return { ...s, screen: s.screen === 'trace' ? 'flow' : 'trace', scrollTrace: 0 };
      case 'showError':
        return { ...s, screen: s.screen === 'error' ? 'flow' : 'error', scrollError: 0 };
      case 'selectTool':
        return { ...s, selectedTool: a.tool };
      case 'openTool':
        return a.tool ? { ...s, selectedTool: a.tool, screen: 'tool', scrollTool: 0 } : s;
      case 'closeTool':
        return { ...s, screen: 'flow' };
      case 'openTask':
        return { ...s, screen: 'task', scrollTask: 0 };
      case 'closeTask':
        return { ...s, screen: 'flow' };
      case 'taskEdited':
        return {
          ...s,
          screen: 'taskConfirm',
          pendingTask: a.task,
          editFromConfirm: Boolean(a.fromConfirm),
          editFromSetup: Boolean(a.fromSetup),
          editingTask: false,
          editError: null,
          awaitingSetup: false,
          awaitingConfirm: false,
          scrollConfirm: 0,
        };
      case 'taskEditFailed':
        return { ...s, editingTask: false, editError: a.error };
      case 'taskEditStarted':
        return { ...s, editingTask: true, editError: null };
      case 'confirmTask':
        return { ...s, screen: 'flow', pendingTask: null, awaitingSetup: s.editFromSetup, editFromConfirm: false, editFromSetup: false, editingTask: false, editError: null };
      case 'discardTask':
        return { ...s, screen: 'flow', pendingTask: null, awaitingSetup: s.editFromSetup, awaitingConfirm: s.editFromConfirm, editFromConfirm: false, editFromSetup: false, editingTask: false, editError: null };
      case 'toggleFocus':
        return { ...s, focus: s.focus === 'AUTHOR' ? 'REVIEWER' : 'AUTHOR' };
      case 'toggleWrap':
        return { ...s, wrap: !s.wrap };
      case 'toggleHelp':
        return { ...s, showHelp: !s.showHelp };
      case 'startFinish':
        return { ...s, screen: 'finishing', showHelp: false, finishFrame: 0 };
      case 'finishTick':
        return { ...s, finishFrame: Math.min(FINISH_ANIMATION_FRAMES, s.finishFrame + 1) };
      default:
        return s;
    }
  }

  // -- the App component ---------------------------------------------------
  let runDone = false;
  let runStarted = false;
  let runFailure = null;
  let runResult = null;

  function App() {
    const app = useApp();
    const { stdout } = useStdout();

    // Mirror engine state into React state so we re-render on each event.
    const [, setTick] = useState(0);
      const [view, dispatchView] = useReducer(viewReducer, initialView);
      const [size, setSize] = useState({
        rows: stdout?.rows || 24,
        cols: stdout?.columns || 80,
      });
      const [animationFrame, setAnimationFrame] = useState(0);
    useEffect(() => {
      const onResize = () => setSize({ rows: stdout.rows, cols: stdout.columns });
      stdout?.on?.('resize', onResize);
      return () => stdout?.off?.('resize', onResize);
    }, [stdout]);

    useEffect(() => {
      if (view.awaitingSetup) return undefined;
      let timeout = null;
      let pending = false;
      const flush = () => {
        timeout = null;
        if (!pending) return;
        pending = false;
        setTick((t) => (t + 1) | 0);
      };
      const schedule = (action) => {
        pending = true;
        if (action?.type === 'result' || action?.type === 'error') {
          if (timeout) {
            clearTimeout(timeout);
            timeout = null;
          }
          flush();
          return;
        }
        if (!timeout) timeout = setTimeout(flush, ENGINE_RENDER_FRAME_MS);
      };
      const off = ensureEngine().subscribe((_state, action) => schedule(action));
      return () => {
        off();
        if (timeout) clearTimeout(timeout);
      };
    }, [view.awaitingSetup]);

    useEffect(() => {
      if (view.screen !== 'finishing') return undefined;
      if (view.finishFrame >= FINISH_ANIMATION_FRAMES) {
        leaveAltScreen();
        app.exit();
        return undefined;
      }
      const timeout = setTimeout(() => dispatchView({ type: 'finishTick' }), FINISH_ANIMATION_FRAME_MS);
      return () => clearTimeout(timeout);
    }, [view.screen, view.finishFrame]);

    // Auto-follow: whenever a new round arrives keep the view pinned.
    const state = engine?.getState() ?? createEmptyEngineState();
    useEffect(() => {
      dispatchView({ type: 'autoFollow', order: state.order });
    }, [state.order.length]);

    useEffect(() => {
      if (approvalBellRung || state.phase !== Phase.Done || !state.result?.approved) return;
      approvalBellRung = true;
      if (process.stdout.isTTY) process.stdout.write('\x07');
    }, [state.phase, state.result?.approved]);

    useEffect(() => {
      if (view.screen === 'finishing') return undefined;
      if (view.cancelled || state.phase === Phase.Done || state.phase === Phase.Error) return undefined;
      const timeout = setTimeout(() => setAnimationFrame((frame) => (frame + 1) | 0), ENGINE_RENDER_FRAME_MS * 3);
      return () => clearTimeout(timeout);
    }, [animationFrame, view.screen, view.cancelled, state.phase]);

    // Kick off the run exactly once, but only after the user confirms (or
    // immediately if --yes / ACP_REVIEW_YES skipped the prompt).
    useEffect(() => {
      if (runStarted || view.awaitingSetup || view.awaitingConfirm || view.cancelled || view.screen === 'taskConfirm') return;
      runStarted = true;
      ensureEngine().run()
        .then((r) => { runResult = r; })
        .catch((err) => { runFailure = err; })
        .finally(() => {
          runDone = true;
          setTick((t) => (t + 1) | 0);
          if (exitAfterApproval) {
            dispatchView({ type: 'startFinish' });
          }
        });
    }, [view.awaitingSetup, view.awaitingConfirm, view.cancelled, view.screen]);

    // If user cancels in the confirm overlay, treat the run as done so `q` exits.
    useEffect(() => {
      if (view.cancelled) {
        runDone = true;
        setTick((t) => (t + 1) | 0);
      }
    }, [view.cancelled]);

    useInput((input, key) => {
      const approvalPending = Boolean(approvalResolver && state.phase === Phase.Done && state.result?.approved);
      const taskIsLong = taskPreviewRows(config.task, Math.max(1, size.cols - 4)).truncated;
      const openTaskEditor = () => {
        const fromConfirm = view.awaitingConfirm;
        const fromSetup = view.awaitingSetup;
        const currentTask = config.task;
        dispatchView({ type: 'taskEditStarted' });
        setTick((t) => (t + 1) | 0);
        setTimeout(() => {
          try {
            dispatchView({
              type: 'taskEdited',
              task: editTaskText(currentTask),
              fromConfirm,
              fromSetup,
            });
            setTick((t) => (t + 1) | 0);
          } catch (error) {
            dispatchView({ type: 'taskEditFailed', error: error instanceof Error ? error.message : String(error) });
          }
        }, 25);
      };

      if (view.editingTask) return;

      if (view.screen === 'task') {
        if (key.escape || input === 'q') dispatchView({ type: 'closeTask' });
        else if (input === 'e' || input === 'E') openTaskEditor();
        else if (input === 'g' || input === 'G') dispatchView({ type: 'scrollEnd' });
        else if (key.upArrow || input === 'k') dispatchView({ type: 'scroll', delta: 1 });
        else if (key.downArrow || input === 'j') dispatchView({ type: 'scroll', delta: -1 });
        else if (key.pageUp) dispatchView({ type: 'scroll', delta: 10 });
        else if (key.pageDown) dispatchView({ type: 'scroll', delta: -10 });
        return;
      }

      if (view.awaitingSetup) {
        if (view.setup.mode === 'summary') {
          if (key.return) {
            dispatchView({ type: 'setupChoose' });
          } else if (key.upArrow || input === 'k') {
            dispatchView({ type: 'setupMove', delta: -1 });
          } else if (key.downArrow || input === 'j') {
            dispatchView({ type: 'setupMove', delta: 1 });
          } else if (key.tab || input === '\t') {
            dispatchView({ type: 'setupToggleRole' });
          } else if (input === ' ') {
            dispatchView({ type: 'setupAssignAgent' });
          } else if (input === 'm' || input === 'M') {
            dispatchView({ type: 'setupModelMode' });
          } else if (input === 's' || input === 'S') {
            dispatchView({ type: 'setupToggleSave' });
          } else if (input === 'e' || input === 'E') {
            openTaskEditor();
          } else if ((input === 'v' || input === 'V') && taskIsLong) {
            dispatchView({ type: 'openTask' });
          } else if (input === 'q' || key.escape) {
            dispatchView({ type: 'cancel' });
          }
        } else if (view.setup.mode === 'customModel') {
          if (key.return) {
            dispatchView({ type: 'setupCustomModelApply' });
          } else if (key.escape) {
            dispatchView({ type: 'setupBack' });
          } else if (key.backspace || key.delete) {
            dispatchView({ type: 'setupCustomModelBackspace' });
          } else if (input === 'q' && !view.setup.customModelInput) {
            dispatchView({ type: 'cancel' });
          } else {
            dispatchView({ type: 'setupCustomModelAppend', input });
          }
        } else if (key.upArrow || input === 'k') {
          dispatchView({ type: 'setupMove', delta: -1 });
        } else if (key.downArrow || input === 'j') {
          dispatchView({ type: 'setupMove', delta: 1 });
        } else if (key.return || input === ' ') {
          dispatchView({ type: 'setupChoose' });
        } else if (input === 'c' || input === 'C') {
          dispatchView({ type: 'setupCustomModelMode' });
        } else if (key.escape || input === 'b' || input === 'B') {
          dispatchView({ type: 'setupBack' });
        } else if (input === 'q') {
          dispatchView({ type: 'cancel' });
        }
        return;
      }

      // Confirm overlay traps all input until resolved.
      if (view.awaitingConfirm) {
        if (input === 'y' || input === 'Y' || key.return) {
          dispatchView({ type: 'confirm' });
        } else if (input === 'e' || input === 'E') {
          openTaskEditor();
        } else if (input === 'n' || input === 'N' || key.escape || (input === 'q')) {
          dispatchView({ type: 'cancel' });
        }
        return;
      }

      if (view.screen === 'taskConfirm') {
        if (key.upArrow || input === 'k') {
          dispatchView({ type: 'scrollConfirm', delta: -1 });
        } else if (key.downArrow || input === 'j') {
          dispatchView({ type: 'scrollConfirm', delta: 1 });
        } else if (key.pageUp) {
          dispatchView({ type: 'scrollConfirm', delta: -10 });
        } else if (key.pageDown) {
          dispatchView({ type: 'scrollConfirm', delta: 10 });
        } else if (input === 'g' || input === 'G') {
          dispatchView({ type: 'scrollConfirmTop' });
        } else if (key.return || input === 'y' || input === 'Y') {
          const nextTask = view.pendingTask ?? config.task;
          const changed = nextTask !== config.task;
          config.task = nextTask;
          config.taskSource = { kind: 'edited' };
          if (approvalPending) {
            resolveApproval(changed
              ? {
                continue: true,
                feedback: `The task was edited after approval. Continue with the updated task:\n${config.task}`,
              }
              : { continue: false });
          }
          dispatchView({ type: 'confirmTask' });
          setTick((t) => (t + 1) | 0);
        } else if (key.escape || input === 'n' || input === 'N' || input === 'q') {
          dispatchView({ type: 'discardTask' });
        } else if (input === 'e' || input === 'E') {
          openTaskEditor();
        }
        return;
      }

      if (approvalPending && (input === 'f' || input === 'F')) {
        forceContinueAfterApproval();
      } else if (approvalPending && (key.return || input === 'q')) {
        exitAfterApproval = input === 'q';
        resolveApproval({ continue: false });
      } else if (state.phase === Phase.Error && (input === 'x' || input === 'X')) dispatchView({ type: 'showError' });
      else if (key.leftArrow) dispatchView({ type: 'select', delta: -1, order: state.order });
      else if (key.rightArrow)  dispatchView({ type: 'select', delta: 1, order: state.order });
      else if (view.screen === 'tool' && (key.escape || input === 'q')) dispatchView({ type: 'closeTool' });
      else if (view.screen === 'task' && (key.escape || input === 'q')) dispatchView({ type: 'closeTask' });
      else if (input === 'g')   dispatchView({ type: 'jumpLatest', order: state.order });
      else if (input === 'G')   dispatchView({ type: 'scrollEnd' });
      else if (key.upArrow)     dispatchView({ type: 'scroll', delta: 1 });
      else if (key.downArrow)   dispatchView({ type: 'scroll', delta: -1 });
      else if (key.pageUp)      dispatchView({ type: 'scroll', delta: 10 });
      else if (key.pageDown)    dispatchView({ type: 'scroll', delta: -10 });
      else if (input === 'k')   dispatchView({ type: 'scroll', delta: 1 });
      else if (input === 'j')   dispatchView({ type: 'scroll', delta: -1 });
      else if (key.tab || input === '\t') dispatchView({ type: 'toggleFocus' });
      else if (input === 't')   dispatchView({ type: 'toggleTrace' });
      else if (input === '[')   dispatchView({ type: 'selectTool', tool: moveToolSelection(-1) });
      else if (input === ']' || input === '/')   dispatchView({ type: 'selectTool', tool: moveToolSelection(1) });
      else if (key.return || input === 'd') dispatchView({ type: 'openTool', tool: currentToolSelection() });
      else if (input === 'e' || input === 'E') openTaskEditor();
      else if ((input === 'v' || input === 'V') && taskPreview.truncated) dispatchView({ type: 'openTask' });
      else if (input === 'w')   dispatchView({ type: 'toggleWrap' });
      else if (input === '?')   dispatchView({ type: 'toggleHelp' });
      else if (input === 'q' && runDone) {
        dispatchView({ type: 'startFinish' });
      }
    });

    // ---- layout budget -------------------------------------------------
    // The TUI must occupy EXACTLY size.rows (including the pathological
    // case of size.rows in {0, 1, 2, 3, ...}). Layout vertically:
    //
    //   header (headerHeight) + panes (paneOuter) + nav (navHeight) + footer (footerHeight) === size.rows
    //
    // No spacer rows are rendered, so none are subtracted. We allocate
    // strictly top-down, giving each component what's *left*, with no
    // minimum floors -- that way on a 1-row terminal we render only the
    // header (truncated to 1 row), and on 0 rows we render nothing. The
    // invariant header + pane + nav + footer === size.rows always holds.
    const totalRows = Math.max(0, size.rows);
    const idealHeader = 7;        // title + cwd/task/rounds + border; role status lives on pane borders
    const idealNav = 3;           // 1 line + 2 border
    const idealFooter = state.phase === Phase.Error ? 4 : 0;

    // Header is the highest-priority chunk; give it up to its ideal but
    // never more than the total. Nav comes next, then footer, then panes
    // get every remaining row.
    const headerHeight = Math.min(idealHeader, totalRows);
    let remaining = totalRows - headerHeight;
    const navHeight = Math.min(idealNav, remaining);
    remaining -= navHeight;
    const footerHeight = Math.min(idealFooter, remaining);
    remaining -= footerHeight;
    const paneOuter = remaining; // exactly fills the rest, may be 0

    // Pane internals: top border + bottom border. Role/round/status and token
    // usage live in the custom top border instead of consuming body rows.
    const paneInner = Math.max(0, paneOuter - Math.min(2, paneOuter));

    // Content width: each pane gets half of (cols - 1 spacer column),
    // minus border+padding (4) per pane.
    const paneOuterCols = Math.max(4, Math.floor((Math.max(1, size.cols) - 1) / 2));
    const paneCols = Math.max(1, paneOuterCols - 4);
    const headerCols = Math.max(1, size.cols - 4);

    // ---- header --------------------------------------------------------
    const taskPreview = fixedTaskPreviewRows(config.task, headerCols);
    const header = h(
      Box,
      {
        flexDirection: 'column',
        borderStyle: 'round',
        paddingX: 1,
        height: headerHeight,
        overflow: 'hidden',
      },
      line(h(Text, { bold: true, color: 'cyan' }, `${TUI_STATIC_STATUS_MARK} ACP Author/Reviewer Loop`), 'title'),
      line(h(Text, { color: 'yellow', wrap: 'truncate-end' }, `cwd:      ${config.cwd}`), 'cwd'),
      ...taskPreview.rows.map((row, i) => line(h(Text, { color: i === 0 ? 'white' : 'cyan', wrap: 'truncate-end' }, row || ' '), `task-${i}`)),
      line(h(Text, { color: 'green', wrap: 'truncate-end' }, `rounds:   max ${config.maxRounds}`), 'rounds'),
    );

    // ---- panes ---------------------------------------------------------
    const selectedRound = view.selected ?? state.order[state.order.length - 1] ?? null;
    const round = selectedRound != null ? state.rounds.get(selectedRound) : null;
    const total = state.order.length;
    const idx = selectedRound == null ? -1 : state.order.indexOf(selectedRound);

    function toolsForSelection() {
      const pane = view.focus === 'AUTHOR' ? round?.AUTHOR : round?.REVIEWER;
      return pane?.tools ?? [];
    }

    function currentToolSelection() {
      const tools = toolsForSelection();
      if (tools.length === 0 || selectedRound == null) return null;
      const selected = view.selectedTool?.round === selectedRound && view.selectedTool?.role === view.focus
        ? tools.find((tool) => tool.id === view.selectedTool.toolCallId)
        : null;
      const tool = selected ?? tools[tools.length - 1];
      return { round: selectedRound, role: view.focus, toolCallId: tool.id };
    }

    function moveToolSelection(delta) {
      const tools = toolsForSelection();
      if (tools.length === 0 || selectedRound == null) return null;
      const current = view.selectedTool?.round === selectedRound && view.selectedTool?.role === view.focus
        ? tools.findIndex((tool) => tool.id === view.selectedTool.toolCallId)
        : -1;
      const base = current >= 0 ? current : (delta < 0 ? tools.length : -1);
      const next = Math.max(0, Math.min(tools.length - 1, base + delta));
      return { round: selectedRound, role: view.focus, toolCallId: tools[next].id };
    }

    function roleStatusToPaneStatus(status) {
      if (status === 'ready') return PaneStatus.Completed;
      if (String(status).startsWith('launching') || String(status).startsWith('session ready')) {
        return PaneStatus.Running;
      }
      return PaneStatus.Pending;
    }

    function paneHasActivity(pane) {
      return Boolean(pane?.startedAt || pane?.finishedAt || pane?.flow?.length || pane?.lines?.length || pane?.current || pane?.tools?.length);
    }

    function visibleFlowRows(pane, width) {
      if (!pane) return [];
      const rows = [];
      const flow = pane.flow?.length
        ? pane.flow
        : [{ id: 'snapshot-text', kind: 'text', text: [...pane.lines, pane.current].join('\n') }];
      for (let index = 0; index < flow.length; index += 1) {
        const item = flow[index];
        if (item.kind === 'tool') {
          const run = [item];
          const skipped = [];
          while (flow[index + 1]?.kind === 'tool' || isBlankTextFlow(flow[index + 1])) {
            index += 1;
            if (flow[index]?.kind === 'tool') run.push(flow[index]);
            else skipped.push(flow[index]);
          }
          if (run.length === 1) {
            for (const blank of skipped) rows.push({ key: blank.id, kind: 'text', text: blank.text || '' });
          }
          if (run.length > 1) {
            const status = mergedToolStatus(run);
            const failed = run.filter((tool) => tool.status === 'failed' || tool.status === 'error').length;
            const succeeded = run.filter((tool) => ['completed', 'done', 'success'].includes(tool.status)).length;
            const summary = `${run.length} Tool Calls (${succeeded} done, ${failed} failed)`;
            rows.push({ key: `tool-run-${run.map((tool) => tool.toolCallId || tool.id).join('-')}-summary`, kind: 'tool', status, text: summary });
            run.slice(0, 3).forEach((tool) => {
              const text = `  ${summarizeTool(tool, { compact: true })}`;
              const parts = view.wrap ? wrapLine(text, width) : [text];
              parts.forEach((part, partIndex) => rows.push({ key: `tool-${tool.toolCallId || tool.id}-${partIndex}`, kind: 'tool', status: tool.status || status, text: part, toolCallId: tool.toolCallId }));
            });
            if (run.length > 3) {
              rows.push({ key: `tool-run-${run.map((tool) => tool.toolCallId || tool.id).join('-')}-more`, kind: 'tool', status, text: `  ... ${run.length - 3} more; press [/] then Enter for full tool details` });
            }
          } else {
            for (const tool of run) {
              const status = tool.status || 'running';
              const text = summarizeTool(tool);
              const parts = view.wrap ? wrapLine(text, width) : [text];
              parts.forEach((part, partIndex) => rows.push({ key: `tool-${tool.toolCallId || tool.id}-${partIndex}`, kind: 'tool', status, text: part, toolCallId: tool.toolCallId }));
            }
          }
          continue;
        }
        const normalized = normalizeDisplayText(item.text || '');
        const logical = normalized.split('\n');
        logical.forEach((part, i) => {
          const isCursorLine = pane.status === PaneStatus.Running
            && i === logical.length - 1
            && item === flow[flow.length - 1];
          const value = isCursorLine ? `${part}\u258F` : part;
          const prefix = item.kind === 'reasoning' ? '💭 ' : '';
          const parts = view.wrap ? (value === '' ? [''] : wrapLine(value, width)) : [value];
          parts.forEach((text, partIndex) => rows.push({
            key: `${item.id || `flow-${index}`}-${i}-${partIndex}`,
            kind: item.kind === 'reasoning' ? 'reasoning' : 'text',
            text: `${partIndex === 0 ? prefix : '   '}${text}`,
          }));
        });
      }
      return rows;
    }

    function isBlankTextFlow(item) {
      return item?.kind !== 'tool' && String(item?.text ?? '').trim() === '';
    }

    function formatTraceRows(item) {
      const { role, entry } = item;
      if (entry.kind !== 'wire') return [];
      const prefix = `${new Date(entry.at).toLocaleTimeString()} ${role} ${entry.direction}`;
      const method = entry.method ? ` ${entry.method}` : '';
      const id = entry.id !== undefined ? ` #${entry.id}` : '';
      const header = `${prefix}${method}${id}`;
      const body = stringifyValue(entry.frame);
      if (!body) return [header];
      try {
        const pretty = JSON.stringify(JSON.parse(body), null, 2);
        return [header, ...pretty.split('\n').map((line) => `  ${line}`)];
      } catch {
        return [header, `  ${body}`];
      }
    }

    function Pane({ role, color, pane, active }) {
      const status = paneHasActivity(pane) ? pane.status : roleStatusToPaneStatus(state.statuses?.[role]);
      // Fixed footer rows keep pane height stable: one status row plus the
      // bottom border row that carries token usage.
      const footerRows = 2;
      // Never let textBudget exceed what the pane actually has room for; if
      // the terminal is so small there's no room left after reserved footer rows, drop
      // text entirely (overflow:hidden on the pane keeps us inside bounds).
      const textBudget = Math.max(0, paneInner - footerRows);
      const scroll = role === 'AUTHOR' ? view.scrollAuthor : view.scrollReviewer;

      let visible;
      let visibleStart = 0;
      if (textBudget === 0) {
        visible = [];
      } else if (!pane || ((pane.flow?.length ?? 0) === 0 && pane.lines.length === 0 && !pane.current)) {
        visible = [{ kind: 'text', text: '(no output yet)' }];
        while (visible.length < textBudget) visible.push({ kind: 'text', text: '' });
      } else {
        const expanded = visibleFlowRows(pane, paneCols);
        // Scroll: 0 means pin to bottom (last `textBudget` lines visible).
        const end = Math.max(textBudget, expanded.length - scroll);
        const start = Math.max(0, end - textBudget);
        visibleStart = start;
        visible = expanded.slice(start, end);
      }
      while (visible.length < textBudget) visible.push({ kind: 'text', text: '' });

      const settings = role === 'AUTHOR' ? config.authorSettings : config.reviewerSettings;
      const agent = agentName(settings);
      const model = settings.model || 'default';
      const animated = status === PaneStatus.Running || status === PaneStatus.Pending;
      const progress = animated ? ` ${TUI_PROGRESS_FRAMES[animationFrame % TUI_PROGRESS_FRAMES.length]}` : '';
      const headerLabel = `${role} \u2014 Round ${selectedRound ?? '-'} ${status}${progress} \u00B7 ${agent} (${model})`;
      const usageLabel = formatUsage(pane?.usage);
      const timingLabel = formatDuration(paneElapsedMs(pane));
      const focused = active && view.focus === role;
      const borderColor = color;
      return h(
        Box,
        {
          flexDirection: 'column',
          width: paneOuterCols,
          height: paneOuter,
          overflow: 'hidden',
        },
        paneBorderTop(headerLabel, borderColor, focused, paneOuterCols),
        ...visible.map((row, i) => {
          const text = row.text === '' ? ' ' : row.text;
          const cell = padCell(text, paneOuterCols - 4);
          if (row.kind === 'tool') {
            const selected = view.selectedTool?.round === selectedRound
              && view.selectedTool?.role === role
              && view.selectedTool?.toolCallId === row.toolCallId;
            return line(
              h(
                Text,
                { wrap: 'truncate-end' },
                h(Text, { color: borderColor }, '│ '),
                h(Text, { color: toolStatusColor(row.status), inverse: selected }, cell),
                h(Text, { color: borderColor }, ' │'),
              ),
              row.key ?? `l-${role}-${selectedRound ?? 'none'}-${visibleStart + i}`,
            );
          }
          return line(
            h(
              Text,
              { wrap: 'truncate-end' },
              h(Text, { color: borderColor }, '│ '),
              h(Text, { color: row.kind === 'reasoning' ? 'gray' : 'white', italic: row.kind === 'reasoning' }, cell),
              h(Text, { color: borderColor }, ' │'),
            ),
            row.key ?? `l-${role}-${selectedRound ?? 'none'}-${visibleStart + i}`,
          );
        }),
        paneStatusLine(pane, paneOuterCols, role, borderColor),
        paneBorderBottom(paneOuterCols, usageLabel, timingLabel, focused, borderColor),
      );
    }

    function paneBorderTop(label, color, focused, width) {
      const safeWidth = Math.max(4, width);
      const labelWidth = Math.max(0, safeWidth - 6);
      const fitted = fitText(label, labelWidth, { ellipsis: true });
      const labelText = ` ${fitted.text} `;
      const fill = Math.max(0, safeWidth - fitted.width - 4);
      return line(
        h(
          Text,
          { wrap: 'truncate-end' },
          h(Text, { color }, '╭'),
          h(Text, { color }, '─'),
          h(Text, { color, bold: focused }, labelText),
          h(Text, { color }, '─'.repeat(fill)),
          h(Text, { color }, '╮'),
        ),
        `border-top-${color}-${focused ? 'focused' : 'idle'}`,
      );
    }

    function paneStatusLine(pane, width, role, borderColor) {
      const text = pane?.error
        ? `error: ${pane.error}`
        : pane?.stopReason ? `done: ${pane.stopReason}` : '';
      return line(
        h(
          Text,
          { wrap: 'truncate-end' },
          h(Text, { color: borderColor }, '│ '),
          h(Text, { color: pane?.error ? 'red' : undefined, dimColor: !pane?.error }, padCell(text, width - 4)),
          h(Text, { color: borderColor }, ' │'),
        ),
        `${role}-status`,
      );
    }

    function paneBorderBottom(width, usageLabel, timingLabel, focused, borderColor) {
      const safeWidth = Math.max(4, width);
      const maxUsageWidth = Math.max(0, Math.floor(safeWidth * 0.48));
      const maxTimingWidth = Math.max(0, Math.floor(safeWidth * 0.24));
      const fittedUsage = usageLabel ? fitText(usageLabel, maxUsageWidth, { ellipsis: true }) : { text: '', width: 0 };
      const fittedTiming = timingLabel ? fitText(timingLabel, maxTimingWidth, { ellipsis: true }) : { text: '', width: 0 };
      const usageText = fittedUsage.text ? ` ${fittedUsage.text} ` : '';
      const timingText = fittedTiming.text ? ` ${fittedTiming.text} ` : '';
      const labelWidth = (usageText ? fittedUsage.width + 2 : 0) + (timingText ? fittedTiming.width + 2 : 0);
      const fill = Math.max(0, safeWidth - labelWidth - 2);
      return line(
        h(
          Text,
          { wrap: 'truncate-end' },
          h(Text, { color: borderColor }, `╰${'─'.repeat(fill)}`),
          usageText ? h(Text, { color: 'yellow', bold: focused }, usageText) : null,
          timingText ? h(Text, { color: 'cyan', bold: focused }, timingText) : null,
          h(Text, { color: borderColor }, '╯'),
        ),
        `border-bottom-${borderColor}-${focused ? 'focused' : 'idle'}`,
      );
    }

    const split = h(
      Box,
      { flexDirection: 'row', height: paneOuter, overflow: 'hidden' },
      h(Pane, { role: 'AUTHOR', color: 'cyan', pane: round?.AUTHOR, active: true }),
      h(Box, { width: 1 }),
      h(Pane, { role: 'REVIEWER', color: 'magenta', pane: round?.REVIEWER, active: true }),
    );

    function TraceView() {
      const traceRows = state.trace
        .flatMap(formatTraceRows)
        .flatMap((row) => view.wrap ? wrapLine(row, Math.max(1, size.cols - 4)) : [row]);
      const bodyBudget = Math.max(0, paneOuter - Math.min(3, paneOuter));
      const end = Math.max(bodyBudget, traceRows.length - view.scrollTrace);
      const start = Math.max(0, end - bodyBudget);
      const visible = traceRows.length === 0
        ? ['No ACP wire messages captured yet.']
        : traceRows.slice(start, end);
      while (visible.length < bodyBudget) visible.push('');
      return h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'yellow',
          paddingX: 1,
          height: paneOuter,
          overflow: 'hidden',
        },
        line(h(Text, { bold: true, color: 'yellow' }, 'ACP Trace - raw redacted wire messages'), 'trace-header'),
        ...visible.map((row, i) => rowText(row === '' ? ' ' : row, `trace-${i}`)),
      );
    }

    function selectedToolRecord() {
      const selection = view.selectedTool;
      if (!selection) return null;
      const selected = state.rounds.get(selection.round)?.[selection.role];
      const tool = selected?.tools?.find((item) => item.id === selection.toolCallId);
      return tool ? { selection, tool } : null;
    }

    function formatToolDetailsRows() {
      const record = selectedToolRecord();
      if (!record) {
        return ['No tool call selected. Press [ or ] in the flow view to select one.'];
      }
      const { selection, tool } = record;
      const rows = [
        `${selection.role} Round ${selection.round} ${tool.tag || ''} ${toolStatusLabel(tool.status || 'running')}`.trim(),
        `id: ${tool.id}`,
        `name: ${tool.name || '(unknown)'}`,
        `title: ${tool.title || '(untitled)'}`,
        `status: ${tool.status || 'running'}`,
        `chars: ${tool.chars ?? 0}`,
        '',
        'input:',
        ...prettyValue(tool.input).map((line) => `  ${line}`),
        '',
        'output:',
        ...prettyValue(tool.output).map((line) => `  ${line}`),
      ];
      return rows;
    }

    function prettyValue(value) {
      if (value == null) return ['(empty)'];
      if (typeof value === 'string') return value.split('\n');
      try {
        return JSON.stringify(value, null, 2).split('\n');
      } catch {
        return [stringifyValue(value)];
      }
    }

    function ToolView() {
      const detailRows = formatToolDetailsRows()
        .flatMap((row) => view.wrap ? wrapLine(row, Math.max(1, size.cols - 4)) : [row]);
      const bodyBudget = Math.max(0, paneOuter - Math.min(3, paneOuter));
      const end = Math.max(bodyBudget, detailRows.length - view.scrollTool);
      const start = Math.max(0, end - bodyBudget);
      const visible = detailRows.slice(start, end);
      while (visible.length < bodyBudget) visible.push('');
      return h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: '#ffa500',
          paddingX: 1,
          height: paneOuter,
          overflow: 'hidden',
        },
        line(
          shortcutLine(
            h(Text, { bold: true, color: '#ffa500' }, 'Tool Call Details'),
            muted(' - '),
            shortcutLabel('[/]'),
            muted(' select, '),
            shortcutLabel('Esc/q'),
            muted(' back'),
          ),
          'tool-header',
        ),
        ...visible.map((row, i) => rowText(row === '' ? ' ' : row, `tool-${i}`)),
      );
    }

    function TaskView() {
      const taskRows = String(config.task || '(empty)')
        .split('\n')
        .flatMap((row) => view.wrap ? wrapLine(row, Math.max(1, size.cols - 4)) : [row]);
      const bodyBudget = Math.max(0, paneOuter - Math.min(4, paneOuter));
      const end = Math.max(bodyBudget, taskRows.length - view.scrollTask);
      const start = Math.max(0, end - bodyBudget);
      const visible = taskRows.slice(start, end);
      while (visible.length < bodyBudget) visible.push('');
      return h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'cyan',
          paddingX: 1,
          height: paneOuter,
          overflow: 'hidden',
        },
        line(
          shortcutLine(
            h(Text, { bold: true, color: 'cyan' }, 'Full Task'),
            muted(' - '),
            shortcutLabel('e'),
            muted(' edit, '),
            shortcutLabel('Esc/q'),
            muted(' back, '),
            shortcutLabel('↑/↓'),
            muted(' scroll'),
          ),
          'task-header',
        ),
        line(shortcutLine(muted('Tip: press '), shortcutLabel('e'), muted(' here to edit the task.')), 'task-edit-tip'),
        ...visible.map((row, i) => rowText(row === '' ? ' ' : row, `task-full-${i}`)),
      );
    }

    function ErrorView() {
      const rows = String(state.error || 'error')
        .split('\n')
        .flatMap((row) => view.wrap ? wrapLine(row, Math.max(1, size.cols - 4)) : [row]);
      const bodyBudget = Math.max(0, paneOuter - Math.min(3, paneOuter));
      const end = Math.max(bodyBudget, rows.length - view.scrollError);
      const start = Math.max(0, end - bodyBudget);
      const visible = rows.slice(start, end);
      while (visible.length < bodyBudget) visible.push('');
      return h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'double',
          borderColor: 'red',
          paddingX: 1,
          height: paneOuter,
          overflow: 'hidden',
        },
        line(
          shortcutLine(
            h(Text, { bold: true, color: 'red' }, 'Startup Error'),
            muted(' - '),
            shortcutLabel('x'),
            muted(' back, '),
            shortcutLabel('\u2191/\u2193'),
            muted(' scroll'),
          ),
          'error-header',
        ),
        ...visible.map((row, i) => rowText(row === '' ? ' ' : row, `error-${i}`)),
      );
    }

    function FinishView() {
      const frame = Math.min(view.finishFrame, FINISH_ANIMATION_FRAMES);
      const progress = frame / FINISH_ANIMATION_FRAMES;
      const innerWidth = Math.max(8, Math.min(64, size.cols - 8));
      const filled = Math.min(innerWidth, Math.floor(innerWidth * progress));
      const block = String.fromCodePoint(0x2588);
      const shade = String.fromCodePoint(0x2591);
      const sparkleGlyph = String.fromCodePoint(0x2726);
      const diamondGlyph = String.fromCodePoint(0x25C6);
      const bar = `${block.repeat(filled)}${shade.repeat(innerWidth - filled)}`;
      const sparkle = Array.from({ length: Math.max(1, Math.min(7, Math.floor(size.cols / 12))) }, (_, index) => (index + frame) % 2 ? sparkleGlyph : diamondGlyph).join(' ');
      const finishTop = `${String.fromCodePoint(0x2554)}${String.fromCodePoint(0x2550).repeat(31)}${String.fromCodePoint(0x2557)}`;
      const finishMiddle = `${String.fromCodePoint(0x2551)}            APPROVED           ${String.fromCodePoint(0x2551)}`;
      const finishBottom = `${String.fromCodePoint(0x255A)}${String.fromCodePoint(0x2550).repeat(31)}${String.fromCodePoint(0x255D)}`;
      const topPad = Math.max(0, Math.floor((size.rows - 11) / 2));
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          alignItems: 'center',
          overflow: 'hidden',
        },
        ...Array.from({ length: topPad }, (_, i) => h(Text, { key: `finish-pad-${i}` }, '')),
        h(Text, { color: 'green', bold: true }, sparkle),
        h(Text, { color: 'cyan', bold: true }, finishTop),
        h(Text, { color: 'cyan', bold: true }, finishMiddle),
        h(Text, { color: 'cyan', bold: true }, finishBottom),
        h(Text, { color: 'green', bold: true }, 'Author/Reviewer loop finished'),
        h(Text, { dimColor: true }, `Rounds ${state.result?.rounds ?? state.order.length}/${state.result?.maxRounds ?? config.maxRounds}`),
        h(Text, { color: 'yellow' }, `[${bar}]`),
        h(Text, { dimColor: true }, 'Closing TUI...'),
        h(Text, { color: 'green', bold: true }, sparkle),
      );
    }

    if (view.screen === 'finishing') return h(FinishView);

    const mainView = view.screen === 'trace'
      ? h(TraceView)
      : view.screen === 'tool' ? h(ToolView)
        : view.screen === 'task' ? h(TaskView)
          : view.screen === 'error' ? h(ErrorView)
            : split;

    // ---- nav -----------------------------------------------------------
    const navText = total === 0
      ? 'Waiting for first round...'
      : `Round ${selectedRound} (${idx + 1}/${total})`;
    const focusHint = `focus:${view.focus.toLowerCase()}`;
    const wrapHint = view.wrap ? 'wrap:on' : 'wrap:off';
    const followHint = view.follow ? 'follow:on' : 'follow:off';
    const screenHint = view.screen === 'trace'
      ? 'trace:on'
      : view.screen === 'tool' ? 'tool:detail'
        : view.screen === 'task' ? 'task:view'
        : view.screen === 'error' ? 'error:detail'
          : 'trace:off';
    const resultHint = state.phase === Phase.Done && state.result
      ? state.result.approved
        ? shortcutLine(
          h(Text, { color: 'green', bold: true }, 'APPROVED'),
          muted(' - '),
          shortcutLabel('f'),
          muted(' force continue, '),
          shortcutLabel('e'),
          muted(' edit/resume, '),
          shortcutLabel('Enter'),
          muted(' accept, '),
          shortcutLabel('q'),
          muted(' accept+quit'),
        )
        : shortcutLine(
          muted(`Not approved after ${state.result.rounds}/${state.result.maxRounds}; `),
          shortcutLabel('q'),
          muted(' quit'),
        )
      : null;
    const nav = h(
      Box,
      {
        borderStyle: 'round',
        paddingX: 1,
        height: navHeight,
        overflow: 'hidden',
      },
      h(
        Text,
        { wrap: 'truncate-end' },
        resultHint || muted(navText),
        muted('   '),
        shortcutLabel('\u2190/\u2192'),
        muted(' round  '),
        shortcutLabel('\u2191/\u2193'),
        muted(' scroll  '),
        shortcutLabel('Tab'),
        muted(' focus  '),
        shortcutLabel('[/]/'),
        muted(' tool  '),
        shortcutLabel('Enter'),
        muted(' detail  '),
        shortcutLabel('e'),
        muted(' edit  '),
        taskPreview.truncated ? shortcutLabel('v') : null,
        taskPreview.truncated ? muted(' task  ') : null,
        shortcutLabel('t'),
        muted(' trace  '),
        state.phase === Phase.Error ? shortcutLabel('x') : null,
        state.phase === Phase.Error ? muted(' error  ') : null,
        shortcutLabel('w'),
        muted(' wrap  '),
        shortcutLabel('g'),
        muted(' latest  '),
        shortcutLabel('?'),
        muted(' help  '),
        shortcutLabel('q'),
        muted(' quit'),
        '   ',
        h(Text, { color: view.follow ? 'green' : 'yellow' }, followHint),
        ' ',
        h(Text, { color: 'cyan' }, focusHint),
        ' ',
        h(Text, { color: view.screen === 'trace' || view.screen === 'error' ? 'yellow' : 'gray' }, screenHint),
        ' ',
        h(Text, { color: view.wrap ? 'green' : 'gray' }, wrapHint),
      ),
    );

    // ---- footer (only for errors; final status stays in nav to avoid layout jumps)
    let footer = null;
    if (state.phase === Phase.Error) {
      footer = h(
        Box,
        {
          flexDirection: 'column',
          borderStyle: 'double',
          paddingX: 1,
          height: footerHeight,
          overflow: 'hidden',
        },
        h(Text, { color: 'red', wrap: 'truncate-end' }, firstLine(state.error || 'error')),
        shortcutLine(muted('Press '), shortcutLabel('x'), muted(' for details, '), shortcutLabel('q'), muted(' to quit.')),
      );
    }

    // ---- setup / start overlay ----------------------------------------
    if (view.editingTask) {
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            borderColor: 'cyan',
            paddingX: 3,
            paddingY: 1,
            overflow: 'hidden',
          },
          h(Text, { color: 'cyan', bold: true }, `${TUI_SPINNER_FRAMES[animationFrame % TUI_SPINNER_FRAMES.length]} Opening task editor`),
          h(Text, { dimColor: true }, 'The TUI is paused while your editor is active.'),
          h(Text, { dimColor: true }, 'Save and close the editor to return here.'),
        ),
      );
    }

    if (view.awaitingSetup) {
      const options = view.setup.mode === 'summary' ? agentOptions() : setupStepOptions(view.setup);
      const authorAgent = agentDisplayName(view.setup.selections.authorAgentId);
      const reviewerAgent = agentDisplayName(view.setup.selections.reviewerAgentId);
      const authorCliFound = setupRoleCliFound(view.setup, 'author');
      const reviewerCliFound = setupRoleCliFound(view.setup, 'reviewer');
      const authorModel = setupModelLabel(view.setup.selections.authorAgentId, view.setup.selections.authorModel, authorCliFound);
      const reviewerModel = setupModelLabel(view.setup.selections.reviewerAgentId, view.setup.selections.reviewerModel, reviewerCliFound);
      const innerCols = Math.max(24, size.cols - 8);
      const compact = size.cols < 84;
      const taskPreview = fixedTaskPreviewRows(config.task, Math.max(20, innerCols - 12), { prefix: 'Task        ' });
      const modeTitle = view.setup.mode === 'customModel'
        ? `Custom ${view.setup.activeRole.toUpperCase()} model`
        : view.setup.mode === 'model'
        ? `Choose ${view.setup.activeRole.toUpperCase()} model`
        : 'Start author/reviewer loop';
      const bodyBudget = Math.max(0, size.rows - (compact ? 21 : 23));
      const authorStatus = setupRoleStatus(view.setup, 'author');
      const reviewerStatus = setupRoleStatus(view.setup, 'reviewer');
      const roleRows = [
        { role: 'AUTHOR', roleKey: 'author', active: view.setup.activeRole === 'author', agent: authorAgent, model: authorModel, availability: authorStatus, userCliFound: authorCliFound },
        { role: 'REVIEWER', roleKey: 'reviewer', active: view.setup.activeRole === 'reviewer', agent: reviewerAgent, model: reviewerModel, availability: reviewerStatus, userCliFound: reviewerCliFound },
      ];
      const sourceWidth = compact ? 8 : 10;
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            borderColor: 'cyan',
            paddingX: 2,
            paddingY: 1,
            width: size.cols,
            height: size.rows,
            overflow: 'hidden',
          },
          h(Text, { bold: true, color: 'cyan' }, `${TUI_SPINNER_FRAMES[animationFrame % TUI_SPINNER_FRAMES.length]} ${modeTitle}`),
          h(Text, { dimColor: true }, 'Configure the two agents before launching the review loop.'),
          h(Text, null, ''),
          h(Text, { color: 'yellow', wrap: 'truncate-end' }, `Workspace   ${config.cwd}`),
          ...taskPreview.rows.map((row, i) =>
            h(Text, { key: `setup-task-${i}`, color: i === 0 ? 'white' : 'cyan', wrap: 'truncate-end' }, i === 0 ? '' : '            ', row),
          ),
          h(Text, null, ''),
          h(
            Box,
            {
              flexDirection: 'column',
              borderStyle: 'round',
              borderColor: 'cyan',
              paddingX: 1,
              overflow: 'hidden',
            },
            h(Text, { bold: true, color: 'cyan' }, 'Selected roles'),
            h(Text, { dimColor: true }, compact
              ? `${padCell('Role', 10)} ${padCell('Agent', 16)} ${padCell('Model', 14)} ${padCell('Source', sourceWidth)} Launch`
              : `${padCell('Role', 10)} ${padCell('Agent', 20)} ${padCell('Model', 18)} ${padCell('Source', sourceWidth)} ${padCell('CLI', 8)} Launch`),
            ...roleRows.map((row) => h(
              Text,
              { key: `role-${row.role}`, wrap: 'truncate-end' },
              h(Text, { color: row.active ? 'cyan' : undefined, bold: row.active }, `${row.active ? '>' : ' '} ${padCell(row.role, 8)} `),
              padCell(row.agent, compact ? 16 : 20),
              ' ',
              padCell(row.model, compact ? 14 : 18),
              ' ',
              h(Text, { color: setupSourceColor(view.setup, row.roleKey) }, padCell(setupSourceLabel(view.setup, row.roleKey), sourceWidth)),
              compact ? '' : ' ',
              compact ? null : h(Text, { color: userCliColor(row.userCliFound) }, padCell(userCliLabel(row.userCliFound), 8)),
              ' ',
              h(Text, { color: availabilityColor(row.availability) }, availabilityLabel(row.availability)),
            )),
            h(Text, { dimColor: true, wrap: 'truncate-end' }, `Save config ${view.setup.selections.save ? `yes (${config.preferencesPath})` : 'no'}`),
          ),
          h(Text, null, ''),
          h(Text, { color: 'gray', dimColor: true }, '─'.repeat(Math.max(8, Math.min(innerCols, 72)))),
          h(Text, { bold: true, color: 'green' }, view.setup.mode === 'summary' ? 'Available agents' : view.setup.mode === 'customModel' ? 'Type custom model' : 'Available models'),
          ...(view.setup.mode === 'summary'
            ? [
              h(Text, { key: 'agents-header', dimColor: true }, compact
                ? `${padCell('Agent', 18)} ${padCell('Default model', 14)} Launch`
                : `${padCell('Agent', 22)} ${padCell('Default model', 18)} ${padCell('CLI', 8)} Launch`),
              ...options.slice(0, bodyBudget).map((option, i) => h(
                Text,
                {
                  key: `agent-${option.id}`,
                  color: option.disabled ? 'gray' : i === view.setup.cursor ? 'green' : undefined,
                  inverse: i === view.setup.cursor && !option.disabled,
                  dimColor: option.disabled,
                  wrap: 'truncate-end',
                },
                `${i === view.setup.cursor ? '>' : ' '} ${padCell(option.label, compact ? 16 : 20)} ${padCell(defaultModelLabel(option), compact ? 14 : 18)} `,
                compact ? null : h(Text, { color: userCliColor(option.userCliFound) }, padCell(userCliLabel(option.userCliFound), 8)),
                ' ',
                h(Text, { color: availabilityColor(option.availability) }, availabilityLabel(option.availability)),
              )),
            ]
            : view.setup.mode === 'customModel'
              ? [
                h(Text, { key: 'custom-help', dimColor: true, wrap: 'truncate-end' }, 'Enter a model id, or leave empty to use the agent default.'),
                h(Text, { key: 'custom-input', color: 'green', wrap: 'truncate-end' }, `> ${view.setup.customModelInput ?? ''}_`),
              ]
              : [
              h(Text, { key: 'models-header', dimColor: true }, `${padCell('Model', 28)} Applies to ${view.setup.activeRole.toUpperCase()}`),
              ...options.slice(0, bodyBudget).map((option, i) =>
                h(
                  Text,
                  {
                    key: option.id,
                    color: i === view.setup.cursor ? 'green' : undefined,
                    inverse: i === view.setup.cursor,
                    wrap: 'truncate-end',
                  },
                  `${i === view.setup.cursor ? '>' : ' '} ${option.label}`,
                ),
              ),
            ]),
          h(Text, null, ''),
          view.setup.error
            ? h(Text, { color: 'red', wrap: 'wrap' }, view.setup.error)
            : h(Text, { dimColor: true, wrap: 'truncate-end' }, 'CLI means the agent launcher is on PATH. Launch shows whether this run starts locally or via npx.'),
          view.setup.mode === 'summary'
            ? h(Text, null, shortcutLabel('Tab'), ' role   ', shortcutLabel('\u2191/\u2193'), ' agent   ', shortcutLabel('Space'), ' assign   ', shortcutLabel('m'), ' model   ', shortcutLabel('e'), ' edit   ', taskPreview.truncated ? shortcutLabel('v') : null, taskPreview.truncated ? ' view   ' : null, shortcutLabel('s'), ' save   ', shortcutLabel('Enter'), ' start   ', shortcutLabel('q', 'red'), ' cancel')
            : view.setup.mode === 'customModel'
              ? h(Text, null, shortcutLabel('type'), ' model   ', shortcutLabel('Enter'), ' apply   ', shortcutLabel('Esc'), ' back   ', shortcutLabel('q', 'red'), ' cancel if empty')
              : h(Text, null, shortcutLabel('\u2191/\u2193'), ' select   ', shortcutLabel('Enter'), ' choose   ', shortcutLabel('c'), ' custom   ', shortcutLabel('Esc/b'), ' back   ', shortcutLabel('q', 'red'), ' cancel'),
        ),
      );
    }

    if (view.screen === 'taskConfirm') {
      const confirmCols = Math.max(20, size.cols - 10);
      const taskLines = wrapLine(view.pendingTask || '(empty)', confirmCols);
      const bodyBudget = Math.max(0, size.rows - 8);
      const maxStart = Math.max(0, taskLines.length - bodyBudget);
      const start = Math.min(view.scrollConfirm, maxStart);
      const visibleLines = bodyBudget > 0 ? taskLines.slice(start, start + bodyBudget) : [];
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            borderColor: 'yellow',
            paddingX: 2,
            paddingY: 1,
            width: size.cols,
            height: size.rows,
            overflow: 'hidden',
          },
          h(Text, { bold: true, color: 'yellow' }, 'Confirm updated task'),
          h(Text, null, ''),
          ...visibleLines.map((row, i) =>
            h(Text, { key: `task-confirm-${start}-${i}`, wrap: 'wrap' }, start + i === 0 ? 'task:     ' : '          ', row),
          ),
          h(Text, null, ''),
          h(
            Text,
            null,
            h(Text, { color: 'green', bold: true }, 'Enter'),
            ' apply   ',
            h(Text, { color: 'cyan', bold: true }, 'e'),
            ' edit again   ',
            h(Text, { color: 'red', bold: true }, 'Esc'),
            ' discard   ',
            shortcutLabel('\u2191/\u2193'),
            ' scroll',
          ),
        ),
      );
    }

    // ---- confirm overlay (first frame, blocks engine.run) -------------
    if (view.awaitingConfirm) {
      const confirmCols = Math.max(20, size.cols - 10);
      const taskLines = wrapLine(config.task || '(empty)', confirmCols);
      const lines = [
        ['cwd:      ', config.cwd],
        ['task src: ', config.taskSource?.kind === 'file' ? config.taskSource.path : '(inline text)'],
        ['task:     ', taskLines[0] ?? ''],
        ...taskLines.slice(1).map((row) => ['          ', row]),
        ['author:   ', agentSummary(config.authorSettings)],
        ['          model: ', config.authorSettings.model || '(agent default)'],
        ['reviewer: ', agentSummary(config.reviewerSettings)],
        ['          model: ', config.reviewerSettings.model || '(agent default)'],
        ['rounds:   ', `max ${config.maxRounds}`],
        ['trace:    ', config.trace ? 'enabled' : 'disabled'],
      ];
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            borderColor: 'cyan',
            paddingX: 2,
            paddingY: 1,
            width: size.cols,
            height: size.rows,
            overflow: 'hidden',
          },
          h(Text, { bold: true, color: 'cyan' }, 'Start author/reviewer loop?'),
          h(Text, null, ''),
          ...lines.map((row, i) =>
            h(
              Text,
              { key: i, wrap: 'wrap' },
              h(Text, { dimColor: true }, row[0]),
              row[1],
            ),
          ),
          h(Text, null, ''),
          h(
            Text,
            null,
            h(Text, { color: 'green', bold: true }, 'y'),
            ' / ',
            h(Text, { color: 'green', bold: true }, 'Enter'),
            ' to start   ',
            h(Text, { color: 'cyan', bold: true }, 'e'),
            ' edit task   ',
            h(Text, { color: 'red', bold: true }, 'n'),
            ' / ',
            h(Text, { color: 'red', bold: true }, 'Esc'),
            ' to cancel',
          ),
          h(
            Text,
            { dimColor: true },
            'Tip: pass --yes (or set ACP_REVIEW_YES=1) to skip this prompt.',
          ),
        ),
      );
    }

    // ---- cancelled overlay --------------------------------------------
    if (view.cancelled) {
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            borderColor: 'red',
            paddingX: 2,
            paddingY: 1,
            width: size.cols,
            height: size.rows,
            overflow: 'hidden',
          },
          h(Text, { color: 'red', bold: true }, 'Cancelled.'),
          shortcutLine(muted('Press '), shortcutLabel('q'), muted(' to quit.')),
        ),
      );
    }

    // ---- help overlay --------------------------------------------------
    if (view.showHelp) {
      return h(
        Box,
        {
          flexDirection: 'column',
          width: size.cols,
          height: size.rows,
          overflow: 'hidden',
        },
        h(
          Box,
          {
            flexDirection: 'column',
            borderStyle: 'double',
            paddingX: 2,
            paddingY: 1,
            width: size.cols,
            height: size.rows,
            overflow: 'hidden',
          },
          h(Text, { bold: true, color: 'cyan' }, 'Keybindings'),
          h(Text, null, ''),
          keyBindingLine('\u2190 / \u2192', 'Move between rounds'),
          keyBindingLine('\u2191 / \u2193', 'Scroll focused pane up/down by 1 line'),
          keyBindingLine('PgUp/PgDn', 'Scroll focused pane by 10 lines'),
          keyBindingLine('j / k', 'Same as down/up arrows'),
          keyBindingLine('Tab', 'Switch focused pane (AUTHOR \u2194 REVIEWER)'),
          keyBindingLine('g', 'Jump to latest round, re-enable follow'),
          keyBindingLine('G', 'Reset scroll to bottom in focused pane'),
          keyBindingLine('[ / ] / /', 'Select previous/next tool call in focused pane'),
          keyBindingLine('Enter / d', 'Open selected tool call details'),
          keyBindingLine('Esc / q', 'Return from tool detail view'),
          keyBindingLine('v', 'View full task text'),
          keyBindingLine('e', 'Edit task text'),
          keyBindingLine('t', 'Toggle ACP trace view'),
          keyBindingLine('w', 'Toggle soft wrap'),
          keyBindingLine('?', 'Toggle this help'),
          keyBindingLine('f', 'Force another round after reviewer approval'),
          keyBindingLine('q', 'Quit (only after the run completes)'),
          h(Text, null, ''),
          shortcutLine(muted('Press '), shortcutLabel('?'), muted(' again to dismiss.')),
        ),
      );
    }

    function keyBindingLine(keys, description) {
      const padding = ' '.repeat(Math.max(1, 12 - keys.length));
      return shortcutLine(
        muted('  '),
        shortcutLabel(keys),
        muted(`${padding}${description}`),
      );
    }

    return h(
      Box,
      {
        flexDirection: 'column',
        width: size.cols,
        height: size.rows,
        overflow: 'hidden',
      },
      header,
      mainView,
      nav,
      footer,
    );
  }

  // Disable Ink's own scrollback growth: we render in alt-screen, fixed size.
  const inkApp = render(h(App), {
    stdout: process.stdout,
    stdin: process.stdin,
    exitOnCtrlC: true,
    patchConsole: false,
  });

  try {
    await inkApp.waitUntilExit();
  } finally {
    process.off('exit', restore);
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    leaveAltScreen();
  }

  if (runFailure) throw runFailure;
  if (!runResult) return 1;
  return runResult.approved ? 0 : 1;
}
