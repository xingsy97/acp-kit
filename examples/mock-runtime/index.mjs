#!/usr/bin/env node

import { PassThrough } from 'node:stream';
import process from 'node:process';

import { createRuntime } from '@acp-kit/core';

const runtime = createRuntime({
  profile: {
    id: 'mock',
    displayName: 'Mock ACP Agent',
    command: 'mock-agent',
    args: [],
    startupTimeoutMs: 5000,
  },
  cwd: process.cwd(),
  host: {
    chooseAuthMethod: async ({ methods }) => {
      console.log(`[host] auth requested, auto-selecting: ${methods[0]?.id}`);
      return methods[0]?.id ?? null;
    },
    requestPermission: async (request) => {
      console.log(`[host] permission requested for ${request.toolName}, auto-approving`);
      return 'allow_once';
    },
    log: (entry) => console.log(`[host:${entry.level}] ${entry.message}`),
  },
  spawnProcess: createMockSpawn(),
  connectionFactory: createMockConnectionFactory(),
});

console.log('\nACP Kit mock-runtime demo starting');

let session;
try {
  session = await runtime.newSession();
  console.log(`session created: ${session.sessionId}`);

  session.on('event', printEvent);

  const result = await session.prompt('Explain what ACP Kit is doing for the application layer.');
  console.log(`\nturn result: ${result.stopReason ?? 'unknown'}`);

  printSnapshot(session.getSnapshot());
} catch (error) {
  console.error('\nDemo failed.');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
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
            modes: {
              currentModeId: 'ask',
              availableModes: [
                { id: 'ask', name: 'Ask' },
                { id: 'edit', name: 'Edit' },
              ],
            },
            models: {
              currentModelId: 'mock-model',
              availableModels: [{ modelId: 'mock-model', name: 'Mock Model' }],
            },
          };
        },
        async authenticate({ methodId }) {
          authenticated = true;
          console.log(`[mock-agent] authenticated with method: ${methodId}`);
        },
        async prompt() {
          await emit(client, {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Inspecting runtime lifecycle. ' },
          });

          await emit(client, {
            sessionUpdate: 'usage_update',
            used: 120,
            size: 4096,
            cost: 0,
          });

          const permission = await client.requestPermission({
            toolCall: {
              id: 'tool-1',
              toolName: 'write_file',
              input: { path: 'docs/demo-output.md' },
            },
            options: [
              { optionId: 'proceed_once', name: 'Allow Once' },
              { optionId: 'cancel', name: 'Cancel' },
            ],
          });
          const denied = permission?.outcome?.optionId === 'cancel';

          await emit(client, {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            toolName: 'write_file',
            title: 'Write demo output',
            status: 'running',
            input: { path: 'docs/demo-output.md' },
          });

          await emit(client, {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            title: denied ? 'Write blocked by host' : 'Write completed',
            status: denied ? 'failed' : 'completed',
            toolResponse: denied
              ? { error: 'Host denied the request.' }
              : { ok: true, path: 'docs/demo-output.md' },
          });

          await emit(client, {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: denied
                ? 'The runtime surfaced a permission request and the host denied it.'
                : 'The runtime surfaced a permission request, the host approved it, and the tool completed.',
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

async function emit(client, update) {
  await client.sessionUpdate({ sessionId: 'demo-session', update });
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
      console.log(`[event] ${event.type} used=${event.used} size=${event.size}`);
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
  console.log(`  usage: ${JSON.stringify(snapshot.session.usage)}`);
}
