#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import {
  ClaudeCode,
  CodexCli,
  GeminiCli,
  GitHubCopilot,
  OpenCode,
  PermissionDecision,
  QwenCode,
  createAcpRuntime,
  createRuntimeInspector,
  formatStartupDiagnostics,
  isAcpStartupError,
} from '@acp-kit/core';

const agents = {
  claude: ClaudeCode,
  codex: CodexCli,
  copilot: GitHubCopilot,
  gemini: GeminiCli,
  opencode: OpenCode,
  qwen: QwenCode,
};

const defaults = {
  authorAgent: 'copilot',
  authorModel: 'claude-opus-4.7',
  reviewerAgent: 'codex',
  reviewerModel: 'gpt-5.5',
  maxRounds: 10,
};

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('-')));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));

if (flags.has('--help') || flags.has('-h')) {
  printHelp();
  process.exit(0);
}

if (positional.length < 2) {
  console.error('Missing required arguments: <cwd> and <task>.\n');
  printHelp();
  process.exit(2);
}

const cwd = path.resolve(positional[0]);
const task = positional.slice(1).join(' ').trim();
const maxRounds = readPositiveInt(process.env.MAX_ROUNDS, defaults.maxRounds);
const skipConfirm = flags.has('--yes') || flags.has('-y') || process.env.ACP_REVIEW_YES === '1';

if (!task) {
  console.error('Missing required argument: <task>.\n');
  printHelp();
  process.exit(2);
}

const authorSettings = {
  agent: readAgent('AUTHOR_AGENT', defaults.authorAgent),
  model: readOptionalEnv('AUTHOR_MODEL', defaults.authorModel),
  prompt: ({ round, feedback }) => round === 1
    ? `You are the AUTHOR. Working dir: ${cwd}\n\nTask: ${task}\n\n`
      + 'Use your filesystem tools to create or modify files on disk. Do not paste code.'
    : `REVIEWER feedback:\n${feedback}\n\nUpdate the files in ${cwd} to address every point.`,
};

const reviewerSettings = {
  agent: readAgent('REVIEWER_AGENT', defaults.reviewerAgent),
  model: readOptionalEnv('REVIEWER_MODEL', defaults.reviewerModel),
  prompt: () =>
    `You are the REVIEWER. Original task: ${task}\n\n`
    + `Inspect the project under ${cwd} using your filesystem tools. `
    + 'Reply APPROVED on its own line if it fully solves the task with no obvious bugs; '
    + 'otherwise reply with a terse numbered list of issues.',
};

printRunSummary({ cwd, task, authorSettings, reviewerSettings, maxRounds, trace: process.env.ACP_REVIEW_TRACE === '1' });
if (!skipConfirm && !await confirmRun()) {
  console.log('Cancelled.');
  process.exit(1);
}

await fs.mkdir(cwd, { recursive: true });

let author;
let reviewer;

try {
  console.log('Launching agents in parallel (this can take a few seconds on cold start)...');
  [author, reviewer] = await Promise.all([
    openRole('AUTHOR', authorSettings),
    openRole('REVIEWER', reviewerSettings),
  ]);

  let feedback = '';
  let approved = false;

  for (let round = 1; round <= maxRounds && !approved; round++) {
    await turn(round, 'AUTHOR', author, authorSettings.prompt({ round, feedback }));
    const reply = await turn(round, 'REVIEWER', reviewer, reviewerSettings.prompt({ round, feedback }));

    feedback = reply.trim();
    approved = feedback.split('\n').some((line) => /^APPROVED\.?$/i.test(line.trim()));
  }

  console.log('\n' + '='.repeat(64));
  if (approved) {
    console.log(`Approved. Files under ${cwd}.`);
  } else {
    console.log(`Not approved after ${maxRounds} rounds.\nLast feedback:\n${feedback}`);
    process.exitCode = 1;
  }
} catch (error) {
  reportError(error);
  process.exitCode = 1;
} finally {
  await closeRole(author);
  await closeRole(reviewer);
}

async function openRole(role, { agent, model }) {
  const log = (message) => console.log(`  [${role.toLowerCase()}] ${message}`);
  const inspector = createRuntimeInspector({ includeWire: process.env.ACP_REVIEW_TRACE === '1' });
  log(`launching ${agent.displayName}...`);
  const runtime = createAcpRuntime({
    agent,
    inspector,
    host: {
      requestPermission: async () => PermissionDecision.AllowOnce,
      chooseAuthMethod: async ({ methods }) => methods[0]?.id ?? null,
    },
  });

  try {
    const session = await runtime.newSession({ cwd });
    if (model) {
      log(`session ready, setting model ${model}...`);
      await session.setModel(model);
    } else {
      log('session ready, leaving default model unchanged...');
    }
    log('ready');
    return {
      inspector,
      session,
      close: async () => {
        await session.dispose();
        await runtime.shutdown();
      },
    };
  } catch (error) {
    await runtime.shutdown().catch(() => undefined);
    if (process.env.ACP_REVIEW_TRACE === '1') {
      console.error(inspector.toJSONL());
    }
    throw error;
  }
}

async function turn(round, role, { session }, prompt) {
  console.log(`\n${'-'.repeat(64)}\nRound ${round} - ${role}\n${'-'.repeat(64)}`);
  const tools = new Map();
  let buffer = '';
  let midLine = false;
  const tag = (id, inputChars = 0) => {
    let existing = tools.get(id);
    if (!existing) {
      existing = { tag: `#${tools.size + 1}`, inputChars };
      tools.set(id, existing);
    }
    return existing;
  };
  const lineFeed = () => {
    if (midLine) {
      process.stdout.write('\n');
      midLine = false;
    }
  };

  const off = session.on({
    messageDelta: (event) => {
      buffer += event.delta;
      process.stdout.write(event.delta);
      midLine = !event.delta.endsWith('\n');
    },
    toolStart: (event) => {
      const tool = tag(event.toolCallId, countChars(event.input));
      lineFeed();
      console.log(`  [tool ${tool.tag} start] ${event.title || event.name}`);
    },
    toolEnd: (event) => {
      const tool = tag(event.toolCallId);
      const chars = Math.max(tool.inputChars, countChars(event.output));
      lineFeed();
      console.log(`  [tool ${tool.tag} ${event.status} - ${chars} chars]`);
    },
    turnCompleted: (event) => {
      lineFeed();
      console.log(`  (turn done: ${event.stopReason ?? 'unknown'})`);
    },
    turnFailed: (event) => {
      lineFeed();
      console.log(`  (turn failed: ${event.error})`);
    },
  });

  try {
    await session.prompt(prompt);
  } finally {
    off();
    lineFeed();
  }
  return buffer;
}

async function closeRole(role) {
  if (!role) return;
  await role.close().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  });
}

function readAgent(envName, fallback) {
  const id = (process.env[envName] || fallback).toLowerCase();
  const agent = agents[id];
  if (!agent) {
    const supported = Object.keys(agents).join(', ');
    throw new Error(`${envName}=${id} is not supported. Use one of: ${supported}.`);
  }
  return agent;
}

function readOptionalEnv(name, fallback) {
  if (!(name in process.env)) return fallback;
  const value = process.env[name]?.trim();
  return value || null;
}

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function printRunSummary({ cwd, task, authorSettings, reviewerSettings, maxRounds, trace }) {
  console.log(`Run configuration
  cwd:            ${cwd}
  task:           ${task}
  author:         ${authorSettings.agent.displayName} (${authorSettings.agent.id})
  author model:   ${authorSettings.model || '(agent default)'}
  reviewer:       ${reviewerSettings.agent.displayName} (${reviewerSettings.agent.id})
  reviewer model: ${reviewerSettings.model || '(agent default)'}
  max rounds:     ${maxRounds}
  trace:          ${trace ? 'enabled' : 'disabled'}
`);
}

async function confirmRun() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Refusing to start without confirmation in a non-interactive terminal. Pass --yes or set ACP_REVIEW_YES=1 to proceed.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Start author/reviewer loop? [y/N] ');
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function reportError(error) {
  if (isAcpStartupError(error)) {
    console.error(formatStartupDiagnostics(error.diagnostics));
    return;
  }
  console.error(error instanceof Error ? error.stack || error.message : String(error));
}

function printHelp() {
  console.log(`ACP Kit Author/Reviewer Loop

Usage:
  npx @acp-kit/author-reviewer-loop <cwd> <task> [--yes]

Arguments:
  cwd                                                        required workspace directory
  task                                                       required task for the AUTHOR to implement

Environment:
  AUTHOR_AGENT=copilot|claude|codex|gemini|qwen|opencode   default: ${defaults.authorAgent}
  AUTHOR_MODEL=<model-id>                                  default: ${defaults.authorModel}
  REVIEWER_AGENT=copilot|claude|codex|gemini|qwen|opencode default: ${defaults.reviewerAgent}
  REVIEWER_MODEL=<model-id>                                default: ${defaults.reviewerModel}
  MAX_ROUNDS=<n>                                            default: ${defaults.maxRounds}
  ACP_REVIEW_YES=1                                          skip confirmation prompt
  ACP_REVIEW_TRACE=1                                        print inspector trace on startup failures
`);
}

function countChars(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((count, item) => count + countChars(item), 0);
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.length;
    if (typeof value.content === 'string') return value.content.length;
    if (Array.isArray(value.content)) return countChars(value.content);
    if (typeof value.diff === 'string') return value.diff.length;
    return Object.values(value).reduce((count, item) => count + countChars(item), 0);
  }
  return 0;
}