#!/usr/bin/env node
/**
 * Quick start example for @acp-kit/core.
 *
 * Spawns an ACP agent, runs a single prompt, and streams normalized session events
 * to stdout. Everything (process, session, runtime) is auto-disposed when iteration
 * completes.
 *
 * Usage:
 *   node ./index.mjs [profile] [prompt]
 *   node ./index.mjs claude "Write a demo for this repo"
 */

import process from 'node:process';
import { runOneShotPrompt, onRuntimeEvent } from '@acp-kit/core';

const profile = process.argv[2] || 'claude';
const prompt = process.argv[3] || 'Write a demo for this repo';

console.log(`profile: ${profile}`);
console.log(`prompt:  ${prompt}\n`);

try {
  for await (const event of runOneShotPrompt({
    profile,
    cwd: process.cwd(),
    prompt,
  })) {
    onRuntimeEvent(event, {
      messageDelta:   (e) => process.stdout.write(e.delta),
      reasoningDelta: (e) => process.stderr.write(`\u001b[2m${e.delta}\u001b[0m`),
      toolStart:      (e) => console.log(`\n\u2192 tool ${e.toolCallId}: ${e.title ?? e.name}`),
      toolEnd:        (e) => console.log(`  ${e.toolCallId} ${e.status}`),
    });
  }
  console.log('\n\u2713 done');
} catch (error) {
  console.error('\nQuick-start failed.');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}