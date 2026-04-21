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
import { runAcpAgent } from '@acp-kit/core';

const profile = process.argv[2] || 'claude';
const prompt = process.argv[3] || 'Write a demo for this repo';

console.log(`profile: ${profile}`);
console.log(`prompt:  ${prompt}\n`);

try {
  for await (const notification of runAcpAgent({
    profile,
    cwd: process.cwd(),
    prompt,
  })) {
    const update = notification.update;
    if (!update) continue;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        process.stdout.write(update.content?.text ?? '');
        break;
      case 'agent_thought_chunk':
        // surface thinking on stderr so it doesn't mix with the answer
        process.stderr.write(`\u001b[2m${update.content?.text ?? ''}\u001b[0m`);
        break;
      case 'tool_call':
        console.log(`\n\u2192 tool: ${update.title ?? update.toolName ?? 'tool'}`);
        break;
      case 'tool_call_update':
        console.log(`  status: ${update.status}`);
        break;
      default:
        // plan, available_commands_update, current_mode_update, usage_update, ...
        break;
    }
  }
  console.log('\n\u2713 done');
} catch (error) {
  console.error('\nQuick-start failed.');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
