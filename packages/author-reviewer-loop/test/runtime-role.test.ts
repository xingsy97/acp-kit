import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runtime: {
    newSession: vi.fn(),
    shutdown: vi.fn(),
  },
  session: {
    setModel: vi.fn(),
    dispose: vi.fn(),
    transcript: { session: { models: { availableModels: [{ id: 'good-model' }] } } },
  },
  terminalHost: {
    terminals: new Map(),
  },
}));

vi.mock('@acp-kit/core', () => ({
  PermissionDecision: { AllowAlways: 'allow-always' },
  createAcpRuntime: vi.fn(() => mocks.runtime),
  createRuntimeInspector: vi.fn(() => ({
    onEntry: vi.fn(() => vi.fn()),
    toJSONL: vi.fn(() => ''),
  })),
}));

vi.mock('@acp-kit/core/node', () => ({
  createLocalFileSystemHost: vi.fn(() => ({})),
  createLocalTerminalHost: vi.fn(() => mocks.terminalHost),
}));

const { openRole } = await import('../lib/runtime/role.mjs');

describe('runtime role adapter', () => {
  beforeEach(() => {
    mocks.runtime.newSession.mockReset();
    mocks.runtime.shutdown.mockReset();
    mocks.session.setModel.mockReset();
    mocks.session.dispose.mockReset();
    mocks.terminalHost.terminals = new Map();
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
});
