#!/usr/bin/env node

import { createInterface } from 'node:readline/promises';
import process from 'node:process';

import { createAcpRuntime } from '@acp-kit/core';

const args = parseArgs(process.argv.slice(2));
if (!args.profile) {
  console.error('Error: --profile <copilot|claude|codex> is required.');
  console.error('See examples/real-agent-cli/README.md');
  process.exit(2);
}

const promptText = args.prompt || 'Describe this repository in two sentences.';
const cwd = args.cwd || process.cwd();

const host = createInteractiveHost({
  autoAuthMethod: args.autoAuth,
  autoPermission: args.autoPermission,
});

const runtime = createAcpRuntime({ profile: args.profile, host });

console.log(`\nACP Kit real-agent-cli demo`);
console.log(`profile: ${args.profile}`);
console.log(`cwd: ${cwd}`);
console.log(`prompt: ${promptText}\n`);

let session;
try {
  session = await runtime.newSession({ cwd });
  console.log(`session created: ${session.sessionId}\n`);

  session.on('event', printEvent);

  const result = await session.prompt(promptText);
  console.log(`\nturn result: ${result.stopReason ?? 'unknown'}`);

  printSnapshot(session.getSnapshot());
} catch (error) {
  console.error('\nDemo failed.');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  await session?.dispose();
  await runtime.shutdown();
}

function createInteractiveHost(options) {
  return {
    async chooseAuthMethod(request) {
      console.log('\n[host] auth required:');
      request.methods.forEach((method, index) => {
        console.log(`  ${index + 1}. ${method.id} (${method.name ?? 'unnamed'})`);
      });

      if (options.autoAuthMethod) {
        console.log(`[host] auto-selected: ${options.autoAuthMethod}`);
        return options.autoAuthMethod;
      }
      if (!process.stdin.isTTY) {
        const fallback = request.methods[0]?.id ?? null;
        console.log(`[host] non-interactive terminal, defaulting to: ${fallback ?? 'none'}`);
        return fallback;
      }

      const input = await ask(`Select auth method [1-${request.methods.length}] (default 1): `);
      const index = Number.parseInt(input || '1', 10) - 1;
      return request.methods[index]?.id ?? request.methods[0]?.id ?? null;
    },

    async requestPermission(request) {
      console.log(`\n[host] permission requested for ${request.toolName}`);
      console.log(`  toolCallId: ${request.toolCallId}`);
      console.log(`  input: ${JSON.stringify(request.input)}`);
      request.options.forEach((option, index) => {
        console.log(`  ${index + 1}. ${option.optionId ?? 'unknown'} (${option.name ?? 'unnamed'})`);
      });

      if (options.autoPermission) {
        console.log(`[host] auto-decision: ${options.autoPermission}`);
        return options.autoPermission;
      }
      if (!process.stdin.isTTY) {
        console.log('[host] non-interactive terminal, defaulting to allow_once');
        return 'allow_once';
      }

      const input = await ask('Decision [1=allow_once, 2=allow_always, 3=deny] (default 1): ');
      return ({ '1': 'allow_once', '2': 'allow_always', '3': 'deny' })[input] ?? 'allow_once';
    },

    log(entry) {
      console.log(`[host:${entry.level}] ${entry.message}`);
    },
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    switch (token) {
      case '--profile':         parsed.profile = next; i += 1; break;
      case '--prompt':          parsed.prompt = next; i += 1; break;
      case '--cwd':             parsed.cwd = next; i += 1; break;
      case '--auto-auth':       parsed.autoAuth = next; i += 1; break;
      case '--auto-permission': parsed.autoPermission = next; i += 1; break;
      default:
        if (!token.startsWith('--') && !parsed.prompt) parsed.prompt = token;
    }
  }
  return parsed;
}

function printEvent(event) {
  switch (event.type) {
    case 'turn.started':
    case 'turn.completed':
    case 'turn.cancelled':
    case 'turn.failed':
    case 'status.changed':
      console.log(`[event] ${event.type}`);
      return;
    case 'message.delta':
    case 'reasoning.delta':
      console.log(`[event] ${event.type} ${JSON.stringify(event.delta)}`);
      return;
    case 'tool.start':
    case 'tool.update':
    case 'tool.end':
      console.log(`[event] ${event.type} ${event.toolCallId} status=${event.status}`);
      return;
    case 'session.usage.updated':
      console.log(`[event] ${event.type} used=${event.used ?? 'n/a'} size=${event.size ?? 'n/a'}`);
      return;
    default:
      console.log(`[event] ${event.type}`);
  }
}

function printSnapshot(snapshot) {
  console.log('\nSnapshot:');
  snapshot.blocks.forEach((block, index) => {
    console.log(`  block ${index + 1}: ${block.kind} completed=${block.completed}`);
  });
  Object.values(snapshot.tools).forEach((tool, index) => {
    console.log(`  tool ${index + 1}: ${tool.name} status=${tool.status}`);
  });
  console.log(`  currentModeId: ${snapshot.session.currentModeId ?? 'n/a'}`);
  console.log(`  currentModelId: ${snapshot.session.currentModelId ?? 'n/a'}`);
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
