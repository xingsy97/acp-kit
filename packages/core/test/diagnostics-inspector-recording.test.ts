import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createAcpRuntime,
  createMemorySessionRecorder,
  createRuntimeInspector,
  isAcpStartupError,
  loadSessionRecording,
  type AcpTransport,
} from '../src/index.js';
import { createFileSessionRecorder, loadFileSessionRecording } from '../src/node.js';

const agent = {
  id: 'test-agent',
  displayName: 'Test Agent',
  command: 'test-agent',
  args: ['--acp'],
};

describe('diagnostics, inspector, and recording', () => {
  it('throws structured startup diagnostics when initialize fails', async () => {
    const transport: AcpTransport = {
      async connect() {
        return {
          connection: {
            initialize: vi.fn().mockRejectedValue(new Error('login required')),
            newSession: vi.fn(),
            prompt: vi.fn(),
            cancel: vi.fn(),
          },
          getDiagnostics: () => ({
            stderr: 'Please run test-agent login first.',
            exitSummary: 'exit code=1',
            exitCode: 1,
          }),
        };
      },
    };

    const runtime = createAcpRuntime({ agent, cwd: 'C:/repo', transport });

    await expect(runtime.ready()).rejects.toMatchObject({
      name: 'AcpStartupError',
      diagnostics: expect.objectContaining({
        agentId: 'test-agent',
        phase: 'initialize',
        stderrTail: 'Please run test-agent login first.',
      }),
    });

    try {
      await runtime.ready();
    } catch (error) {
      expect(isAcpStartupError(error)).toBe(true);
      if (isAcpStartupError(error)) {
        expect(error.diagnostics.hints.map((hint) => hint.code)).toContain('auth-required');
        expect(error.message).toContain('Suggested fixes');
      }
    }
  });

  it('collects runtime observations with createRuntimeInspector', async () => {
    const inspector = createRuntimeInspector();
    const runtime = createAcpRuntime({
      agent,
      cwd: 'C:/repo',
      inspector,
      transport: createSuccessfulTransport(),
    });

    const session = await runtime.newSession();
    await session.dispose();
    await runtime.shutdown();

    const observations = inspector.entries()
      .filter((entry) => entry.kind === 'observation')
      .map((entry) => entry.observation.type);
    expect(observations).toContain('runtime.connect.started');
    expect(observations).toContain('runtime.connect.completed');
    expect(observations).toContain('session.created');
    expect(observations).toContain('session.disposed');
    expect(inspector.toJSONL()).toContain('runtime.connect.completed');
  });

  it('records sessions in memory and replays normalized events', async () => {
    const recording = createMemorySessionRecorder();
    const runtime = createAcpRuntime({
      agent,
      cwd: 'C:/repo',
      recording,
      transport: createSuccessfulTransport({ message: 'hello' }),
    });

    const session = await runtime.newSession();
    await session.prompt('say hello');

    const loaded = await loadSessionRecording(recording, { sessionId: 'session-1' });

    expect(loaded.events.map((event) => event.type)).toContain('message.delta');
    expect(loaded.replay.transcript.blocks).toEqual([
      expect.objectContaining({ kind: 'message', content: 'hello', completed: true }),
    ]);
  });

  it('writes and loads file session recordings from the Node entry point', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-recording-'));
    try {
      const recorder = createFileSessionRecorder({ dir, recordingName: 'run-1' });
      const runtime = createAcpRuntime({
        agent,
        cwd: 'C:/repo',
        recording: recorder,
        transport: createSuccessfulTransport({ message: 'recorded' }),
      });

      const session = await runtime.newSession();
      await session.prompt('record');

      const loaded = loadFileSessionRecording(recorder.recordingPath, { sessionId: 'session-1' });

      expect(loaded.events.map((event) => event.type)).toContain('message.delta');
      expect(loaded.replay.transcript.blocks[0]).toEqual(expect.objectContaining({ content: 'recorded' }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function createSuccessfulTransport(options: { message?: string } = {}): AcpTransport {
  return {
    async connect({ client }) {
      return {
        connection: {
          initialize: vi.fn().mockResolvedValue({ authMethods: [] }),
          newSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
          prompt: vi.fn(async () => {
            if (options.message) {
              await client.sessionUpdate({
                sessionId: 'session-1',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: options.message },
                },
              });
            }
            return { stopReason: 'end_turn' };
          }),
          cancel: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn().mockResolvedValue(undefined),
        },
      };
    },
  };
}