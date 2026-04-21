#!/usr/bin/env node
/**
 * Quick start example for @acp-kit/core.
 *
 * Spawns an ACP agent, runs a single prompt, and streams raw ACP `session/update`
 * notifications to stdout. Everything (process, session, runtime) is auto-disposed when
 * iteration completes.
 *
 * Usage:
 *   node ./index.mjs [profile] [prompt]
 *   node ./index.mjs claude "Write a demo for this repo"
 */

import process from 'node:process';
import { runOneShotPrompt, onSessionUpdate } from '@acp-kit/core';

const profile = process.argv[2] || 'claude';
const prompt = process.argv[3] || 'Write a demo for this repo';

console.log(`profile: ${profile}`);
console.log(`prompt:  ${prompt}\n`);

try {
  for await (const notification of runOneShotPrompt({
    profile,
    cwd: process.cwd(),
    prompt,
  })) {
    onSessionUpdate(notification.update, {
      agentMessageChunk: (u) => process.stdout.write(u.content?.text ?? ''),
      agentThoughtChunk: (u) =>
        process.stderr.write(`\u001b[2m${u.content?.text ?? ''}\u001b[0m`),
      toolCall:       (u) => console.log(`\n\u2192 tool: ${u.title ?? 'tool'}`),
      toolCallUpdate: (u) => console.log(`  status: ${u.status}`),
    });
  }
  console.log('\n\u2713 done');
} catch (error) {
  console.error('\nQuick-start failed.');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
