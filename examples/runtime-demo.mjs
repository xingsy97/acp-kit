#!/usr/bin/env node

import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';

import { createRuntime } from '@acp-kit/core';

const args = parseArgs(process.argv.slice(2));
const promptText = args.prompt || 'Explain what ACP Kit is already doing for the application layer.';
const cwd = args.cwd || process.cwd();
const profile = args.profile || null;

const host = createDemoHost({
  autoAuthMethod: args.autoAuth,
  autoPermission: args.autoPermission,
});

const runtime = profile
  ? createRuntime({
    profile,
    cwd,
    host,
  })
  : createRuntime({
    profile: {
      id: 'mock',
      displayName: 'Mock ACP Agent',
      command: 'mock-agent',
      args: [],
      startupTimeoutMs: 5000,
    },
    cwd,
    host,
    spawnProcess: createMockSpawn(),
    connectionFactory: createMockConnectionFactory(),
  });

const modeLabel = profile ? `real profile: ${profile}` : 'mock profile';
console.log(`\nACP Kit demo starting (${modeLabel})`);
console.log(`cwd: ${cwd}`);
console.log(`prompt: ${promptText}\n`);

let session;

try {
  session = await runtime.newSession();
  console.log(`session created: ${session.sessionId}`);
  printInitialSessionState(session.getSnapshot());

  session.on('event', (event) => {
    printEvent(event);
  });

  const result = await session.prompt(promptText);
  const snapshot = session.getSnapshot();

  console.log(`\nturn result: ${result.stopReason || 'unknown'}`);
  printSnapshot(snapshot);
} catch (error) {
  console.error('\nDemo failed.');
  console.error(formatError(error));
  process.exitCode = 1;
} finally {
  await session?.dispose();
}

function createMockSpawn() {
  return () => ({
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
}

function createMockConnectionFactory() {
  let client = null;
  let authenticated = false;
  let sessionAttempts = 0;

  return {
    create({ client: runtimeClient }) {
      client = runtimeClient;
      return {
        async initialize() {
          return {
            authMethods: [
              { id: 'device', name: 'Device Code' },
              { id: 'browser', name: 'Browser Sign-In' },
            ],
          };
        },
        async newSession() {
          sessionAttempts += 1;
          if (!authenticated && sessionAttempts === 1) {
            const error = new Error('auth required');
            error.code = -32000;
            throw error;
          }
          return {
            sessionId: 'demo-session',
            configOptions: [
              { optionId: 'approval_mode', name: 'Approval Mode' },
            ],
            modes: {
              currentModeId: 'ask',
              availableModes: [
                { id: 'ask', name: 'Ask' },
                { id: 'edit', name: 'Edit' },
              ],
            },
            models: {
              currentModelId: 'gpt-5.4',
              availableModels: [
                { modelId: 'gpt-5.4', name: 'GPT-5.4' },
              ],
            },
          };
        },
        async authenticate({ methodId }) {
          authenticated = true;
          console.log(`auth completed with method: ${methodId}`);
        },
        async prompt() {
          await emitUpdate(client, {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Inspecting runtime lifecycle. ' },
          });
          await sleep(40);

          await emitUpdate(client, {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: 'explain-runtime', title: 'Explain runtime behavior' },
            ],
          });
          await emitUpdate(client, {
            sessionUpdate: 'usage_update',
            used: 120,
            size: 4096,
            cost: 0,
          });
          await sleep(40);

          const permission = await client.requestPermission({
            toolCall: {
              id: 'tool-1',
              toolName: 'write_file',
              input: { path: 'docs/demo-output.md' },
            },
            options: [
              { optionId: 'proceed_once', name: 'Allow Once' },
              { optionId: 'proceed_always', name: 'Always Allow' },
              { optionId: 'cancel', name: 'Cancel' },
            ],
          });

          await emitUpdate(client, {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            toolName: 'write_file',
            title: 'Write demo output',
            status: 'running',
            input: { path: 'docs/demo-output.md' },
          });
          await sleep(40);

          const denied = permission?.outcome?.optionId === 'cancel';
          await emitUpdate(client, {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            title: denied ? 'Write blocked by host' : 'Write completed',
            status: denied ? 'failed' : 'completed',
            toolResponse: denied
              ? { error: 'Host denied the request.' }
              : { ok: true, path: 'docs/demo-output.md' },
          });
          await sleep(40);

          await emitUpdate(client, {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: denied
                ? 'The runtime surfaced a permission request and the host denied it. '
                : 'The runtime surfaced a permission request, the host approved it, and the tool completed. ',
            },
          });
          await sleep(40);

          await emitUpdate(client, {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'It also normalized session updates into stable events and maintained transcript state.',
            },
          });

          return { stopReason: denied ? 'blocked_by_host' : 'end_turn' };
        },
        async cancel() {
          return undefined;
        },
        async dispose() {
          return undefined;
        },
      };
    },
  };
}

function createDemoHost(options) {
  return {
    async chooseAuthMethod(request) {
      console.log('\n[host] auth requested');
      request.methods.forEach((method, index) => {
        console.log(`  ${index + 1}. ${method.id} (${method.name || 'unnamed'})`);
      });

      if (options.autoAuthMethod) {
        console.log(`[host] auto-selected auth method: ${options.autoAuthMethod}`);
        return options.autoAuthMethod;
      }

      if (!process.stdin.isTTY) {
        const fallback = request.methods[0]?.id || null;
        console.log(`[host] non-interactive terminal, defaulting to: ${fallback || 'none'}`);
        return fallback;
      }

      const input = await ask(`Select auth method [1-${request.methods.length}] (default 1): `);
      const index = Number.parseInt(input || '1', 10) - 1;
      return request.methods[index]?.id || request.methods[0]?.id || null;
    },
    async requestPermission(request) {
      console.log(`\n[host] permission requested for ${request.toolName}`);
      console.log(`  toolCallId: ${request.toolCallId}`);
      console.log(`  input: ${JSON.stringify(request.input)}`);
      request.options.forEach((option, index) => {
        console.log(`  ${index + 1}. ${option.optionId || 'unknown'} (${option.name || 'unnamed'})`);
      });

      if (options.autoPermission) {
        console.log(`[host] auto-selected permission: ${options.autoPermission}`);
        return options.autoPermission;
      }

      if (!process.stdin.isTTY) {
        console.log('[host] non-interactive terminal, defaulting to allow_once');
        return 'allow_once';
      }

      const input = await ask('Permission decision [1-3] (default 1): ');
      const normalized = {
        '1': 'allow_once',
        '2': 'allow_always',
        '3': 'deny',
      };
      return normalized[input] || 'allow_once';
    },
    log(entry) {
      console.log(`[host:${entry.level}] ${entry.message}`);
    },
  };
}

async function emitUpdate(client, update) {
  await client.sessionUpdate({
    sessionId: 'demo-session',
    update,
  });
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--profile') {
      parsed.profile = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--prompt') {
      parsed.prompt = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--cwd') {
      parsed.cwd = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--auto-auth') {
      parsed.autoAuth = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--auto-permission') {
      parsed.autoPermission = argv[index + 1];
      index += 1;
      continue;
    }
    if (!token.startsWith('--') && !parsed.prompt) {
      parsed.prompt = token;
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
      console.log(`[event] ${event.type} ${summarizeLifecycleEvent(event)}`);
      return;
    case 'message.delta':
    case 'reasoning.delta':
      console.log(`[event] ${event.type} ${JSON.stringify(event.delta)}`);
      return;
    case 'message.completed':
    case 'reasoning.completed':
      console.log(`[event] ${event.type} ${JSON.stringify(event.content)}`);
      return;
    case 'tool.start':
    case 'tool.update':
    case 'tool.end':
      console.log(`[event] ${event.type} ${event.toolCallId} status=${event.status}`);
      return;
    case 'session.commands.updated':
      console.log(`[event] ${event.type} commands=${event.commands.length}`);
      return;
    case 'session.config.updated':
      console.log(`[event] ${event.type} options=${event.configOptions.length}`);
      return;
    case 'session.mode.updated':
      console.log(`[event] ${event.type} mode=${event.currentModeId}`);
      return;
    case 'session.modes.updated':
      console.log(`[event] ${event.type} modes=${event.state.availableModes.length}`);
      return;
    case 'session.model.updated':
      console.log(`[event] ${event.type} model=${event.currentModelId}`);
      return;
    case 'session.models.updated':
      console.log(`[event] ${event.type} models=${event.state.availableModels.length}`);
      return;
    case 'session.usage.updated':
      console.log(`[event] ${event.type} used=${event.used ?? 'n/a'} size=${event.size ?? 'n/a'} cost=${event.cost ?? 'n/a'}`);
      return;
    default:
      console.log(`[event] ${event.type}`);
  }
}

function summarizeLifecycleEvent(event) {
  if (event.type === 'turn.completed') {
    return `stopReason=${event.stopReason || 'null'}`;
  }
  if (event.type === 'turn.cancelled') {
    return `reason=${event.reason}`;
  }
  if (event.type === 'turn.failed') {
    return `error=${event.error}`;
  }
  if (event.type === 'status.changed') {
    return `${event.previousStatus || 'null'} -> ${event.status}`;
  }
  return `turnId=${event.turnId}`;
}

function printSnapshot(snapshot) {
  console.log('\nSnapshot');
  console.log('blocks:');
  snapshot.blocks.forEach((block, index) => {
    console.log(`  ${index + 1}. ${block.kind} completed=${block.completed} content=${JSON.stringify(block.content)}`);
  });

  console.log('tools:');
  const tools = Object.values(snapshot.tools);
  if (tools.length === 0) {
    console.log('  none');
  } else {
    tools.forEach((tool, index) => {
      console.log(`  ${index + 1}. ${tool.name} status=${tool.status} output=${JSON.stringify(tool.output)}`);
    });
  }

  console.log('session metadata:');
  console.log(`  currentModeId: ${snapshot.session.currentModeId || 'n/a'}`);
  console.log(`  currentModelId: ${snapshot.session.currentModelId || 'n/a'}`);
  console.log(`  commands: ${snapshot.session.commands.length}`);
  console.log(`  configOptions: ${snapshot.session.configOptions.length}`);
  console.log(`  usage: ${JSON.stringify(snapshot.session.usage)}`);
}

function printInitialSessionState(snapshot) {
  console.log('initial session state:');
  console.log(`  currentModeId: ${snapshot.session.currentModeId || 'n/a'}`);
  console.log(`  currentModelId: ${snapshot.session.currentModelId || 'n/a'}`);
  console.log(`  configOptions: ${snapshot.session.configOptions.length}`);
  console.log(`  commands: ${snapshot.session.commands.length}`);
  console.log('');
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

async function ask(question) {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await readline.question(question)).trim();
  } finally {
    readline.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}