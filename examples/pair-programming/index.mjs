#!/usr/bin/env node
/**
 * Pair-programming example: AUTHOR writes files; REVIEWER reads them back and
 * replies APPROVED or a numbered list of issues. Loops until APPROVED or
 * MAX_ROUNDS. Each role is fully described by its settings object below.
 *
 * Usage: node ./index.mjs [cwd] [task]
 */

import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createAcpRuntime } from '@acp-kit/core';

const cwd  = path.resolve(process.argv[2] || process.cwd());
const task = process.argv[3] ||
  'write a very complete, beautiful, production-quality graphical snake game in C#';

const authorSettings = {
  profile: 'claude',
  model:   'sonnet',
  prompt: ({ round, feedback }) => round === 1
    ? `You are the AUTHOR. Working dir: ${cwd}\n\nTask: ${task}\n\n` +
      `Use your filesystem tools to create / modify files on disk. Do not paste code.`
    : `REVIEWER feedback:\n${feedback}\n\nUpdate the files in ${cwd} to address every point.`,
};

const reviewerSettings = {
  profile: 'codex',
  model:   'gpt-5.4',
  prompt: () =>
    `You are the REVIEWER. Original task: ${task}\n\n` +
    `Inspect the project under ${cwd} using your filesystem tools. ` +
    `Reply APPROVED on its own line if it fully solves the task with no ` +
    `obvious bugs; otherwise reply with a terse numbered list of issues.`,
};

const MAX_ROUNDS = 10;

console.log(`cwd:      ${cwd}\nauthor:   ${authorSettings.profile} / ${authorSettings.model}\nreviewer: ${reviewerSettings.profile} / ${reviewerSettings.model}\ntask:     ${task}\n`);
await fs.mkdir(cwd, { recursive: true });

console.log('Launching agents in parallel (this can take a few seconds on cold start)...');
const [author, reviewer] = await Promise.all([
  openRole('AUTHOR',   authorSettings),
  openRole('REVIEWER', reviewerSettings),
]);

try {
  let feedback = '';
  let approved = false;

  for (let round = 1; round <= MAX_ROUNDS && !approved; round++) {
    await turn(round, 'AUTHOR',   author,   authorSettings.prompt({ round, feedback }));
    const reply = await turn(round, 'REVIEWER', reviewer, reviewerSettings.prompt({ round, feedback }));

    feedback = reply.trim();
    approved = feedback.split('\n').some((l) => /^APPROVED\.?$/i.test(l.trim()));
  }

  console.log('\n' + '='.repeat(64));
  if (approved) console.log(`\u2713 Approved. Files under ${cwd}.`);
  else { console.log(`\u2717 Not approved after ${MAX_ROUNDS} rounds.\nLast feedback:\n${feedback}`); process.exitCode = 1; }
} finally {
  await author.close();
  await reviewer.close();
}

async function openRole(role, { profile, model }) {
  const log = (msg) => console.log(`  [${role.toLowerCase()}] ${msg}`);
  log(`launching ${profile}...`);
  const runtime = createAcpRuntime({
    profile,
    host: {
      requestPermission: async () => 'allow_once',
      chooseAuthMethod:  async ({ methods }) => methods[0]?.id ?? null,
    },
  });
  const session = await runtime.newSession({ cwd });
  log(`session ready, setting model ${model}...`);
  await session.setModel(model);
  log(`ready`);
  return {
    session,
    close: async () => { await session.dispose(); await runtime.shutdown(); },
  };
}

async function turn(round, role, { session }, prompt) {
  console.log(`\n${'-'.repeat(64)}\nRound ${round} \u00b7 ${role}\n${'-'.repeat(64)}`);
  const tools = new Map(); // id -> { tag, inputChars }
  let buffer = '';
  let midLine = false;
  const tag = (id, inputChars = 0) => {
    let t = tools.get(id);
    if (!t) { t = { tag: `#${tools.size + 1}`, inputChars }; tools.set(id, t); }
    return t;
  };
  const lf = () => { if (midLine) { process.stdout.write('\n'); midLine = false; } };

  const off = session.on({
    messageDelta:  (e) => { buffer += e.delta; process.stdout.write(e.delta); midLine = !e.delta.endsWith('\n'); },
    toolStart:     (e) => { const t = tag(e.toolCallId, countChars(e.input)); lf(); console.log(`  [tool ${t.tag} start] ${e.title || e.name}`); },
    toolEnd:       (e) => { const t = tag(e.toolCallId); const chars = Math.max(t.inputChars, countChars(e.output)); lf(); console.log(`  [tool ${t.tag} ${e.status} \u00b7 ${chars} chars]`); },
    turnCompleted: (e) => { lf(); console.log(`  (turn done: ${e.stopReason ?? 'unknown'})`); },
    turnFailed:    (e) => { lf(); console.log(`  (turn failed: ${e.error})`); },
  });

  try { await session.prompt(prompt); }
  finally { off(); lf(); }
  return buffer;
}

/** Best-effort char count over common ACP tool input/output shapes. */
function countChars(value) {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((n, v) => n + countChars(v), 0);
  if (typeof value === 'object') {
    if (typeof value.text    === 'string') return value.text.length;
    if (typeof value.content === 'string') return value.content.length;
    if (Array.isArray(value.content))      return countChars(value.content);
    if (typeof value.diff    === 'string') return value.diff.length;
    return Object.values(value).reduce((n, v) => n + countChars(v), 0);
  }
  return 0;
}
