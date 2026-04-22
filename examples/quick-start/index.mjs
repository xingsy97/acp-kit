#!/usr/bin/env node
/**
 * Quick start example for @acp-kit/core.
 *
 * Spawns an ACP agent, runs a single prompt, and streams normalized session events
 * to stdout. Everything (process, session, runtime) is auto-disposed when iteration
 * completes.
 *
 * Usage:
 *   node ./index.mjs [agent] [prompt]
 *   node ./index.mjs claude "Write a demo for this repo"
 *
 * Where [agent] is one of: copilot, claude, codex, gemini, qwen, opencode.
 */

import process from 'node:process';
import {
  runOneShotPrompt,
  onRuntimeEvent,
  GitHubCopilot,
  ClaudeCode,
  CodexCli,
  GeminiCli,
  QwenCode,
  OpenCode,
} from '@acp-kit/core';

const agents = {
  copilot: GitHubCopilot,
  claude:  ClaudeCode,
  codex:   CodexCli,
  gemini:  GeminiCli,
  qwen:    QwenCode,
  opencode: OpenCode,
};

const agentKey = process.argv[2] || 'claude';
const agent = agents[agentKey];
if (!agent) {
  console.error(`Unknown agent: ${agentKey}. Choose one of: ${Object.keys(agents).join(', ')}`);
  process.exit(2);
}
const prompt = process.argv[3] || 'Write a demo for this repo';

console.log(`agent:  ${agent.displayName}`);
console.log(`prompt: ${prompt}\n`);

try {
  for await (const event of runOneShotPrompt({
    agent,
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