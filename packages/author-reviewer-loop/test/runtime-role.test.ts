import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAcpRuntime: vi.fn(),
  runtime: {
    newSession: vi.fn(),
    shutdown: vi.fn(),
  },
  session: {
    setModel: vi.fn(),
    dispose: vi.fn(),
    transcript: { session: { models: { availableModels: [{ id: 'good-model' }] } } },
    on: vi.fn(),
  },
  sessionUsageListeners: [] as Array<(event: unknown) => void>,
  sessionPlanListeners: [] as Array<(event: unknown) => void>,
  terminalHost: {
    terminals: new Map(),
  },
  terminalResolveCwd: undefined as undefined | ((requestedCwd?: string) => string),
  inspectorListeners: [] as Array<(entry: unknown) => void>,
}));

vi.mock('@acp-kit/core', () => ({
  PermissionDecision: { AllowAlways: 'allow-always' },
  createAcpRuntime: mocks.createAcpRuntime,
  createRuntimeInspector: vi.fn(() => ({
    onEntry: vi.fn((listener: (entry: unknown) => void) => {
      mocks.inspectorListeners.push(listener);
      return vi.fn();
    }),
    toJSONL: vi.fn(() => ''),
  })),
}));

vi.mock('@acp-kit/core/node', () => ({
  createLocalFileSystemHost: vi.fn(() => ({})),
  createLocalTerminalHost: vi.fn((options: { resolveCwd(requestedCwd?: string): string }) => {
    mocks.terminalResolveCwd = options.resolveCwd;
    return mocks.terminalHost;
  }),
}));

const { closeRole, openRole } = await import('../lib/runtime/role.mjs');

describe('runtime role adapter', () => {
  beforeEach(() => {
    mocks.createAcpRuntime.mockReset();
    mocks.runtime.newSession.mockReset();
    mocks.runtime.shutdown.mockReset();
    mocks.session.setModel.mockReset();
    mocks.session.dispose.mockReset();
    mocks.terminalHost.terminals = new Map();
    mocks.terminalResolveCwd = undefined;
    mocks.inspectorListeners.length = 0;
    mocks.sessionUsageListeners.length = 0;
    mocks.sessionPlanListeners.length = 0;
    mocks.session.on.mockReset();
    mocks.session.on.mockImplementation((type: string, listener: (event: unknown) => void) => {
      if (type === 'session.usage.updated') {
        mocks.sessionUsageListeners.push(listener);
      }
      if (type === 'session.plan.updated') {
        mocks.sessionPlanListeners.push(listener);
      }
      return () => {};
    });
    mocks.createAcpRuntime.mockReturnValue(mocks.runtime);
    mocks.runtime.newSession.mockResolvedValue(mocks.session);
    mocks.runtime.shutdown.mockResolvedValue(undefined);
    mocks.session.dispose.mockResolvedValue(undefined);
  });

  it('disposes a created session when model setup fails', async () => {
    const child = { killed: false, kill: vi.fn() };
    mocks.terminalHost.terminals.set('child', child);

    await expect(openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: {},
      settings: {
        agent: { displayName: 'Author', command: 'author' },
        model: 'bad-model',
        modelEnvName: 'AUTHOR_MODEL',
      },
    })).rejects.toThrow('bad-model');

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(mocks.session.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it('surfaces cleanup failure alongside the original startup failure', async () => {
    mocks.session.dispose.mockRejectedValueOnce(new Error('cleanup failed while disposing session'));

    const thrown = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: {},
      settings: {
        agent: { displayName: 'Author', command: 'author' },
        model: 'bad-model',
        modelEnvName: 'AUTHOR_MODEL',
      },
    }).catch((error) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.message).toBe('Role startup failed and cleanup also failed.');
    expect(thrown.errors.map((error: Error) => error.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('bad-model'),
      'cleanup failed while disposing session',
    ]));
  });

  it('reports ACP session.usage.updated events to the renderer while the role is open', async () => {
    const onUsageUpdate = vi.fn();

    const state = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: true,
      renderer: { onUsageUpdate },
      settings: {
        agent: { displayName: 'Author', command: 'author' },
        model: null,
        modelEnvName: 'AUTHOR_MODEL',
      },
    });

    expect(mocks.sessionUsageListeners.length).toBe(1);
    mocks.sessionUsageListeners[0]?.({
      type: 'session.usage.updated',
      used: 1234,
      size: 200_000,
      cost: 0.05,
    });

    expect(onUsageUpdate).toHaveBeenCalledWith({
      role: 'AUTHOR',
      usage: expect.objectContaining({ used: 1234, size: 200_000, cost: 0.05 }),
    });

    onUsageUpdate.mockClear();
    mocks.sessionUsageListeners[0]?.({
      type: 'session.usage.updated',
      inputTokens: 5,
      cost: null,
    });

    expect(onUsageUpdate.mock.calls[0]?.[0].usage).toMatchObject({ inputTokens: 5 });
    expect(onUsageUpdate.mock.calls[0]?.[0].usage.cost).toBeUndefined();

    await state.close();
  });

  it('maps startup observer phases to concise role status updates', async () => {
    const onRoleStatus = vi.fn();

    const state = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: { onRoleStatus },
      settings: {
        agent: { id: 'author', displayName: 'Author', command: 'author' },
        model: null,
        modelEnvName: 'AUTHOR_MODEL',
      },
    });

    const startupObserver = mocks.createAcpRuntime.mock.calls[0]?.[0]?.startupObserver;
    startupObserver.mark({ phase: 'adapter process spawn begin', detail: {} });
    startupObserver.mark({ phase: 'ACP initialize begin', detail: {} });
    startupObserver.mark({ phase: 'newSession begin', detail: {} });

    expect(onRoleStatus).toHaveBeenCalledWith({ role: 'AUTHOR', message: 'spawning...' });
    expect(onRoleStatus).toHaveBeenCalledWith({ role: 'AUTHOR', message: 'handshaking...' });
    expect(onRoleStatus).toHaveBeenCalledWith({ role: 'AUTHOR', message: 'new session...' });

    await state.close();
  });

  it('rejects terminal cwd paths outside the workspace root', async () => {
    const state = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: {},
      settings: {
        agent: { displayName: 'Author', command: 'author' },
        model: null,
        modelEnvName: 'AUTHOR_MODEL',
      },
    });

    expect(mocks.terminalResolveCwd?.('subdir')).toBe(path.resolve(process.cwd(), 'subdir'));
    expect(() => mocks.terminalResolveCwd?.('..')).toThrow('escapes workspace root');

    if (process.platform === 'win32') {
      const currentDrive = path.parse(process.cwd()).root.toLowerCase();
      const otherDrive = currentDrive.startsWith('c:') ? 'D:\\outside' : 'C:\\outside';
      expect(() => mocks.terminalResolveCwd?.(otherDrive)).toThrow('escapes workspace root');
    }

    await state.close();
  });

  it('forwards ACP session.plan.updated events to the renderer while the role is open', async () => {
    const onPlanUpdate = vi.fn();

    const state = await openRole({
      role: 'REVIEWER',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: { onPlanUpdate },
      settings: {
        agent: { displayName: 'Reviewer', command: 'reviewer' },
        model: null,
        modelEnvName: 'REVIEWER_MODEL',
      },
    });

    expect(mocks.sessionPlanListeners.length).toBe(1);
    const entries = [
      { content: 'Step A', priority: 'high', status: 'in_progress' },
      { content: 'Step B', priority: 'medium', status: 'pending' },
    ];
    mocks.sessionPlanListeners[0]?.({ type: 'session.plan.updated', entries });
    expect(onPlanUpdate).toHaveBeenCalledWith({ role: 'REVIEWER', entries });

    // A subsequent close must not re-emit, and a malformed (non-array) entries
    // payload should still produce an empty entries list rather than throwing.
    onPlanUpdate.mockClear();
    mocks.sessionPlanListeners[0]?.({ type: 'session.plan.updated' });
    expect(onPlanUpdate).toHaveBeenCalledWith({ role: 'REVIEWER', entries: [] });

    await state.close();
  });

  it('surfaces cleanup failures when closing a real role state', async () => {
    const state = await openRole({
      role: 'AUTHOR',
      cwd: process.cwd(),
      trace: false,
      captureTrace: false,
      renderer: {},
      settings: {
        agent: { displayName: 'Author', command: 'author' },
        model: null,
        modelEnvName: 'AUTHOR_MODEL',
      },
    });
    mocks.session.dispose.mockRejectedValueOnce(new Error('disk full while persisting transcript'));

    const thrown = await closeRole(state).catch((error) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.message).toBe('Failed to clean up ACP role resources.');
    expect(thrown.errors.map((error: Error) => error.message)).toContain('disk full while persisting transcript');
    expect(mocks.runtime.shutdown).toHaveBeenCalledTimes(1);
  });
});
