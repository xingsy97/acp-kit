#!/usr/bin/env node
/**
 * Advanced example: createAcpRuntime + multiple sessions, each scoped to a different
 * working directory. Demonstrates `await using` for automatic resource cleanup.
 *
 * Note: in the current implementation each session spawns its own agent subprocess.
 * The runtime tracks open sessions and disposes them on shutdown.
 *
 * Usage:
 *   node ./index.mjs <profile> <cwd1> <cwd2>
 *   node ./index.mjs claude . ./packages/core
 */

import process from 'node:process';
import { createAcpRuntime } from '@acp-kit/core';

const profile = process.argv[2] || 'claude';
const cwd1 = process.argv[3] || process.cwd();
const cwd2 = process.argv[4] || process.cwd();

await using acp = createAcpRuntime({
  profile,
  host: {
    requestPermission: async () => 'allow_once',
    chooseAuthMethod: async ({ methods }) => methods[0]?.id ?? null,
    log: (entry) => console.log(`[host:${entry.level}] ${entry.message}`),
  },
});

await using s1 = await acp.newSession({ cwd: cwd1 });
await using s2 = await acp.newSession({ cwd: cwd2 });

console.log(`session 1 (${cwd1}): ${s1.sessionId}`);
console.log(`session 2 (${cwd2}): ${s2.sessionId}\n`);

console.log('--- session 1 ---');
for await (const notification of s1.prompt('Briefly summarize this directory.')) {
  printUpdate(notification);
}

console.log('\n\n--- session 2 ---');
const result2 = await s2.prompt('What language is this project written in?');
console.log(`stopReason: ${result2.stopReason ?? 'unknown'}`);

console.log('\nDone. Sessions and runtime will auto-dispose on scope exit.');

function printUpdate(notification) {
  const update = notification.update;
  if (!update) return;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      process.stdout.write(update.content?.text ?? '');
      return;
    case 'tool_call':
      console.log(`\n\u2192 tool: ${update.title ?? update.toolName ?? 'tool'}`);
      return;
    case 'tool_call_update':
      console.log(`  status: ${update.status}`);
      return;
    default:
      return;
  }
}
