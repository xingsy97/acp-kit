import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  createAcpRuntime,
  runOneShotPrompt,
  type AcpConnectionFactory,
  type AcpTransport,
  type SpawnProcess,
  type WireMiddleware,
} from '../src/index.js';

function createFakeSpawn(): SpawnProcess {
  return () => ({
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
}

describe('AcpRuntime', () => {
  it('creates a session and emits normalized prompt lifecycle events', async () => {
    let capturedClient: { sessionUpdate(notification: unknown): Promise<void> } | null = null;
    const connection = {
      initialize: vi.fn().mockResolvedValue({ authMethods: [] }),
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        modes: {
          currentModeId: 'ask',
          availableModes: [{ id: 'ask', name: 'Ask' }],
        },
        models: {
          currentModelId: 'gpt-5.4',
          availableModels: [{ modelId: 'gpt-5.4', name: 'GPT-5.4' }],
        },
      }),
      prompt: vi.fn(async () => {
        await capturedClient?.sessionUpdate({
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'thinking' },
          },
        });
        await capturedClient?.sessionUpdate({
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
        });
        return { stopReason: 'end_turn' };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return connection as never;
      },
    };

    const runtime = createAcpRuntime({
      profile: {
        id: 'test',
        displayName: 'Test Agent',
        command: 'test-agent',
        args: [],
      },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    const session = await runtime.newSession();
    const events: string[] = [];
    session.on('event', (event) => {
      events.push(event.type);
    });

    const result = await session.prompt('hello');
    const snapshot = session.getSnapshot();

    expect(result.stopReason).toBe('end_turn');
    expect(events).toContain('turn.started');
    expect(events).toContain('reasoning.delta');
    expect(events).toContain('message.delta');
    expect(events).toContain('reasoning.completed');
    expect(events).toContain('message.completed');
    expect(events).toContain('turn.completed');
    expect(snapshot.blocks).toEqual([
      expect.objectContaining({ kind: 'reasoning', content: 'thinking', completed: true }),
      expect.objectContaining({ kind: 'message', content: 'hello', completed: true }),
    ]);
    expect(snapshot.session.currentModeId).toBe('ask');
    expect(snapshot.session.currentModelId).toBe('gpt-5.4');
  });

  it('retries session creation after ACP auth is required', async () => {
    const authenticate = vi.fn().mockResolvedValue(undefined);
    const newSession = vi
      .fn()
      .mockRejectedValueOnce({ code: -32000, message: 'auth required' })
      .mockResolvedValueOnce({ sessionId: 'session-2' });

    const connection = {
      initialize: vi.fn().mockResolvedValue({
        authMethods: [{ id: 'device', name: 'Device Code' }],
      }),
      newSession,
      authenticate,
      prompt: vi.fn(),
      cancel: vi.fn(),
    };

    const connectionFactory: AcpConnectionFactory = {
      create() {
        return connection as never;
      },
    };

    const chooseAuthMethod = vi.fn().mockResolvedValue('device');
    const runtime = createAcpRuntime({
      profile: {
        id: 'test',
        displayName: 'Test Agent',
        command: 'test-agent',
        args: [],
      },
      cwd: 'C:/repo',
      host: {
        chooseAuthMethod,
      },
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    const session = await runtime.newSession();

    expect(session.sessionId).toBe('session-2');
    expect(chooseAuthMethod).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith({ methodId: 'device' });
    expect(newSession).toHaveBeenCalledTimes(2);
  });

  it('maps host permission decisions back to ACP option ids', async () => {
    let capturedClient: {
      requestPermission(request: unknown): Promise<{ outcome: { optionId: string } }>;
    } | null = null;

    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'session-3' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      profile: {
        id: 'test',
        displayName: 'Test Agent',
        command: 'test-agent',
        args: [],
      },
      cwd: 'C:/repo',
      host: {
        requestPermission: async () => 'allow_always',
      },
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await runtime.newSession();
    const response = await capturedClient?.requestPermission({
      toolCall: {
        id: 'tool-1',
        toolName: 'write_file',
        input: { path: 'README.md' },
      },
      options: [
        { optionId: 'proceed_once', name: 'Allow Once' },
        { optionId: 'proceed_always', name: 'Always Allow' },
        { optionId: 'cancel', name: 'Cancel' },
      ],
    });

    expect(response).toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'proceed_always',
      },
    });
  });

  it('iterates raw ACP notifications via session.prompt() PromptHandle', async () => {
    let capturedClient: { sessionUpdate(notification: unknown): Promise<void> } | null = null;
    const connection = {
      initialize: vi.fn().mockResolvedValue({ authMethods: [] }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'session-iter' }),
      prompt: vi.fn(async () => {
        await capturedClient?.sessionUpdate({
          sessionId: 'session-iter',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
        });
        await capturedClient?.sessionUpdate({
          sessionId: 'session-iter',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 't1',
            title: 'read_file',
            status: 'pending',
          },
        });
        return { stopReason: 'end_turn' };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return connection as never;
      },
    };

    await using runtime = createAcpRuntime({
      profile: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await using session = await runtime.newSession({ cwd: 'C:/repo' });

    const seen: string[] = [];
    for await (const notification of session.prompt('hi')) {
      const update = (notification as { update?: { sessionUpdate?: string } }).update;
      if (update?.sessionUpdate) seen.push(update.sessionUpdate);
    }

    expect(seen).toEqual(['agent_message_chunk', 'tool_call']);
  });

  it('newSession throws when neither runtime nor call site provides cwd', async () => {
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'unused' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      profile: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await expect(runtime.newSession()).rejects.toThrow(/requires a `cwd`/);
  });

  it('shares one agent process across multiple sessions and exposes initialize metadata', async () => {
    const initialize = vi.fn().mockResolvedValue({
      protocolVersion: 1,
      agentInfo: { name: 'fake-agent', version: '9.9.9' },
      authMethods: [{ id: 'device', name: 'Device' }],
      agentCapabilities: { loadSession: true, promptCapabilities: {} },
    });
    const newSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: 's-1' })
      .mockResolvedValueOnce({ sessionId: 's-2' });

    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize,
          newSession,
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const spawn = vi.fn(createFakeSpawn());
    const runtime = createAcpRuntime({
      profile: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: spawn,
      connectionFactory,
    });

    expect(runtime.isReady).toBe(false);
    const a = await runtime.newSession();
    const b = await runtime.newSession();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(a.sessionId).toBe('s-1');
    expect(b.sessionId).toBe('s-2');
    expect(runtime.isReady).toBe(true);
    expect(runtime.agentInfo?.name).toBe('fake-agent');
    expect(runtime.protocolVersion).toBe(1);
    expect(runtime.agentCapabilities?.loadSession).toBe(true);
    expect(runtime.authMethods).toHaveLength(1);

    await runtime.shutdown();
  });

  it('routes session/update notifications to the matching session by sessionId', async () => {
    let capturedClient: { sessionUpdate(notification: unknown): Promise<void> } | null = null;
    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: vi
            .fn()
            .mockResolvedValueOnce({ sessionId: 'session-A' })
            .mockResolvedValueOnce({ sessionId: 'session-B' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      profile: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    const a = await runtime.newSession();
    const b = await runtime.newSession();

    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.onRawNotification((n) => seenA.push(n));
    b.onRawNotification((n) => seenB.push(n));

    await capturedClient?.sessionUpdate({
      sessionId: 'session-A',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'for A' } },
    });
    await capturedClient?.sessionUpdate({
      sessionId: 'session-B',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'for B' } },
    });

    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);

    await runtime.shutdown();
  });

  it('loadSession resumes a session through connection.loadSession', async () => {
    const loadSession = vi.fn().mockResolvedValue({ modes: undefined, models: undefined });
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({
            authMethods: [],
            agentCapabilities: { loadSession: true, promptCapabilities: {} },
          }),
          newSession: async () => ({ sessionId: 'unused' }),
          loadSession,
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      profile: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    const session = await runtime.loadSession({ sessionId: 'resumed-1' });
    expect(session.sessionId).toBe('resumed-1');
    expect(loadSession).toHaveBeenCalledWith({
      sessionId: 'resumed-1',
      cwd: 'C:/repo',
      mcpServers: [],
    });

    await runtime.shutdown();
  });

  it('loadSession throws when the agent does not advertise loadSession capability', async () => {
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({ authMethods: [], agentCapabilities: { promptCapabilities: {} } }),
          newSession: async () => ({ sessionId: 'unused' }),
          loadSession: async () => undefined,
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      profile: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    await expect(runtime.loadSession({ sessionId: 'x' })).rejects.toThrow(/loadSession capability/);
  });

  it('forwards setMode and setModel to the underlying connection', async () => {
    const setSessionMode = vi.fn().mockResolvedValue(undefined);
    const unstable_setSessionModel = vi.fn().mockResolvedValue(undefined);
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'sess-mode' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
          setSessionMode,
          unstable_setSessionModel,
        } as never;
      },
    };

    const runtime = createAcpRuntime({
      profile: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });

    const session = await runtime.newSession();
    await session.setMode('plan');
    await session.setModel('gpt-5');

    expect(setSessionMode).toHaveBeenCalledWith({ sessionId: 'sess-mode', modeId: 'plan' });
    expect(unstable_setSessionModel).toHaveBeenCalledWith({ sessionId: 'sess-mode', modelId: 'gpt-5' });

    await runtime.shutdown();
  });

  it('setMode/setModel throw when the connection does not implement them', async () => {
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'sess-no-mode' }),
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
        } as never;
      },
    };
    const runtime = createAcpRuntime({
      profile: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    });
    const session = await runtime.newSession();
    await expect(session.setMode('plan')).rejects.toThrow(/session\/set_mode/);
    await expect(session.setModel('gpt-5')).rejects.toThrow(/session\/set_model/);
    await runtime.shutdown();
  });

  it('reconnect tears down the current connection and reconnects on next session', async () => {
    const initialize = vi.fn().mockResolvedValue({ authMethods: [] });
    const newSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: 'before' })
      .mockResolvedValueOnce({ sessionId: 'after' });
    const dispose = vi.fn().mockResolvedValue(undefined);
    const connectionFactory: AcpConnectionFactory = {
      create() {
        return {
          initialize,
          newSession,
          prompt: async () => ({ stopReason: 'end_turn' }),
          cancel: async () => undefined,
          dispose,
        } as never;
      },
    };
    const spawn = vi.fn(createFakeSpawn());
    const runtime = createAcpRuntime({
      profile: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      spawnProcess: spawn,
      connectionFactory,
    });

    const before = await runtime.newSession();
    await runtime.reconnect();
    expect(dispose).toHaveBeenCalledTimes(1);

    const after = await runtime.newSession();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(before.sessionId).toBe('before');
    expect(after.sessionId).toBe('after');

    await runtime.shutdown();
  });

  it('accepts a custom transport in place of the node child-process transport', async () => {
    const connection = {
      initialize: vi.fn().mockResolvedValue({ authMethods: [] }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'custom-transport' }),
      prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      cancel: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const transport: AcpTransport = {
      connect: vi.fn().mockResolvedValue({
        connection: connection as never,
        getDiagnostics: () => ({ stderr: '', exitSummary: null }),
      }),
    };

    const runtime = createAcpRuntime({
      profile: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: {},
      transport,
    });

    const session = await runtime.newSession();
    expect(session.sessionId).toBe('custom-transport');
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(connection.initialize).toHaveBeenCalledTimes(1);

    await runtime.shutdown();
    expect(connection.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('wireMiddleware', () => {
  it('runs Koa-style middleware on outgoing frames and observes mutations', async () => {
    const sentFrames: unknown[] = [];
    const transport: AcpTransport = {
      async connect({ host, client: _client }) {
        // Build a tiny in-process pipeline: middleware → terminator (collect into sentFrames).
        const { composeWireMiddleware, normalizeWireMiddleware } = await import('../src/wire-middleware.js');
        const middlewares = normalizeWireMiddleware(host.wireMiddleware);
        const dispatch = composeWireMiddleware(middlewares, (ctx) => {
          sentFrames.push(ctx.frame);
        });

        const connection = {
          initialize: async () => ({ authMethods: [] }),
          newSession: async () => ({ sessionId: 'wm-1' }),
          prompt: async (params: unknown) => {
            await dispatch({ direction: 'out', frame: { method: 'session/prompt', params } });
            return { stopReason: 'end_turn' };
          },
          cancel: async () => undefined,
        };
        return { connection: connection as never };
      },
    };

    const calls: Array<{ direction: string; frame: unknown }> = [];
    const logger: WireMiddleware = async (ctx, next) => {
      calls.push({ direction: ctx.direction, frame: ctx.frame });
      await next();
    };
    const tagger: WireMiddleware = async (ctx, next) => {
      ctx.frame = { ...(ctx.frame as object), tagged: true };
      await next();
    };

    const runtime = createAcpRuntime({
      profile: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      host: { wireMiddleware: [logger, tagger] },
      transport,
    });
    const session = await runtime.newSession();
    await session.prompt('hi');

    expect(calls).toHaveLength(1);
    expect(calls[0].direction).toBe('out');
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]).toMatchObject({ method: 'session/prompt', tagged: true });

    await runtime.shutdown();
  });

  it('drops a frame when middleware does not call next()', async () => {
    const reached: unknown[] = [];
    const { composeWireMiddleware } = await import('../src/wire-middleware.js');
    const dropAll: WireMiddleware = async () => {
      // do not call next
    };
    const dispatch = composeWireMiddleware([dropAll], (ctx) => {
      reached.push(ctx.frame);
    });
    await dispatch({ direction: 'out', frame: { method: 'whatever' } });
    expect(reached).toHaveLength(0);
  });

  it('throws if a middleware calls next() more than once', async () => {
    const { composeWireMiddleware } = await import('../src/wire-middleware.js');
    const buggy: WireMiddleware = async (_ctx, next) => {
      await next();
      await next();
    };
    const dispatch = composeWireMiddleware([buggy], () => undefined);
    await expect(dispatch({ direction: 'out', frame: {} })).rejects.toThrow(/multiple times/);
  });
});

describe('runOneShotPrompt', () => {
  it('spawns the runtime, runs one prompt, and disposes after iteration', async () => {
    let capturedClient: { sessionUpdate(notification: unknown): Promise<void> } | null = null;
    const connection = {
      initialize: vi.fn().mockResolvedValue({ authMethods: [] }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'one-shot' }),
      prompt: vi.fn(async () => {
        await capturedClient?.sessionUpdate({
          sessionId: 'one-shot',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
        });
        return { stopReason: 'end_turn' };
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    const connectionFactory: AcpConnectionFactory = {
      create({ client }) {
        capturedClient = client as typeof capturedClient;
        return connection as never;
      },
    };

    const seen: string[] = [];
    for await (const notification of runOneShotPrompt({
      profile: { id: 'test', displayName: 'Test', command: 'test-agent', args: [] },
      cwd: 'C:/repo',
      prompt: 'hi',
      spawnProcess: createFakeSpawn(),
      connectionFactory,
    })) {
      const update = (notification as { update?: { sessionUpdate?: string } }).update;
      if (update?.sessionUpdate) seen.push(update.sessionUpdate);
    }

    expect(seen).toEqual(['agent_message_chunk']);
    expect(connection.dispose).toHaveBeenCalled();
  });
});