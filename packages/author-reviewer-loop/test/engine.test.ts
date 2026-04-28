import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openRole: vi.fn(),
  closeRole: vi.fn(),
  runTurn: vi.fn(),
}));

vi.mock('../lib/runtime/role.mjs', () => ({
  openRole: mocks.openRole,
  closeRole: mocks.closeRole,
}));

vi.mock('../lib/runtime/turn.mjs', () => ({
  runTurn: mocks.runTurn,
}));

const { createLoopEngine } = await import('../lib/engine.mjs');

function config(maxRounds = 2) {
  return {
    cwd: process.cwd(),
    maxRounds,
    trace: false,
    tui: false,
    authorSettings: {
      agent: { id: 'author', displayName: 'Author', command: 'author', args: [] },
      model: null,
      prompt: ({ round, feedback }: { round: number; feedback: string }) => `author ${round} ${feedback}`,
    },
    reviewerSettings: {
      agent: { id: 'reviewer', displayName: 'Reviewer', command: 'reviewer', args: [] },
      model: null,
      prompt: ({ round }: { round: number }) => `reviewer ${round}`,
    },
  };
}

describe('author-reviewer-loop engine', () => {
  beforeEach(() => {
    mocks.openRole.mockReset();
    mocks.closeRole.mockReset();
    mocks.runTurn.mockReset();
  });

  it('opens author and reviewer once and reuses their sessions across rounds', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) => {
      if (role === 'REVIEWER') return round === 1 ? '1. Fix this' : 'APPROVED';
      return '';
    });

    const result = await createLoopEngine({ config: config(3) }).run();

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(mocks.openRole).toHaveBeenCalledTimes(2);
    const authorTurns = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'AUTHOR').map(([arg]) => arg.state);
    const reviewerTurns = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'REVIEWER').map(([arg]) => arg.state);
    expect(authorTurns).toEqual([authorState, authorState]);
    expect(reviewerTurns).toEqual([reviewerState, reviewerState]);
  });

  it('only treats APPROVED on its own line as approval', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'NOT APPROVED: still broken' : '',
    );

    const result = await createLoopEngine({ config: config(1) }).run();

    expect(result).toMatchObject({
      approved: false,
      feedback: 'NOT APPROVED: still broken',
      rounds: 1,
    });
  });

  it('does not capture expensive wire traces in TUI mode unless trace is enabled', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const cfg = { ...config(1), tui: true, trace: false };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : '',
    );

    await createLoopEngine({ config: cfg }).run();

    expect(mocks.openRole).toHaveBeenCalledWith(expect.objectContaining({
      role: 'AUTHOR',
      trace: false,
      captureTrace: false,
    }));
    expect(mocks.openRole).toHaveBeenCalledWith(expect.objectContaining({
      role: 'REVIEWER',
      trace: false,
      captureTrace: false,
    }));
  });

  it('fails before any author turn when reviewer startup or model setup fails', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerError = new Error('REVIEWER_MODEL="bad" is not available');
    reviewerError.name = 'ConfigurationError';
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) => {
      if (role === 'REVIEWER') throw reviewerError;
      return authorState;
    });

    await expect(createLoopEngine({ config: config(1) }).run()).rejects.toThrow('not available');

    expect(mocks.openRole).toHaveBeenCalledTimes(2);
    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(mocks.closeRole).toHaveBeenCalledWith(authorState);
  });

  it('accumulates reported token usage into role panes', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({
      role,
      round,
      renderer,
    }: {
      role: 'AUTHOR' | 'REVIEWER';
      round: number;
      renderer: { onTurnSnapshot(event: unknown): void };
    }) => {
      renderer.onTurnSnapshot({
        round,
        role,
        snapshot: {
          text: role === 'REVIEWER' ? 'APPROVED' : 'done',
          status: 'completed',
          tools: [],
          usage: role === 'AUTHOR'
            ? { inputTokens: 100, outputTokens: 25, totalTokens: 125 }
            : { inputTokens: 30, outputTokens: 5, totalTokens: 35 },
        },
      });
      return role === 'REVIEWER' ? 'APPROVED' : 'done';
    });

    const engine = createLoopEngine({ config: config(1) });
    await engine.run();
    const state = engine.getState();
    const round = state.rounds.get(1);

    expect(round?.AUTHOR.usage).toMatchObject({ inputTokens: 100, outputTokens: 25, totalTokens: 125 });
    expect(round?.REVIEWER.usage).toMatchObject({ inputTokens: 30, outputTokens: 5, totalTokens: 35 });
  });

  it('keeps latest ACP context usage instead of adding used and size across rounds', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({
      role,
      round,
      renderer,
    }: {
      role: 'AUTHOR' | 'REVIEWER';
      round: number;
      renderer: { onTurnSnapshot(event: unknown): void };
    }) => {
      renderer.onTurnSnapshot({
        round,
        role,
        snapshot: {
          text: role === 'REVIEWER' && round === 2 ? 'APPROVED' : 'continue',
          status: 'completed',
          tools: [],
          usage: role === 'AUTHOR'
            ? { used: round * 100, size: 1_000 }
            : { used: round * 10, size: 500 },
        },
      });
      return role === 'REVIEWER' && round === 2 ? 'APPROVED' : 'continue';
    });

    const engine = createLoopEngine({ config: config(2) });
    await engine.run();
    const state = engine.getState();
    const round = state.rounds.get(2);

    expect(round?.AUTHOR.usage).toMatchObject({ used: 200, size: 1_000 });
    expect(round?.REVIEWER.usage).toMatchObject({ used: 20, size: 500 });
  });

  it('updates role panes from ACP usage events that arrive outside turn snapshots', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({
      role,
      round,
      renderer,
    }: {
      role: 'AUTHOR' | 'REVIEWER';
      round: number;
      renderer: { onTurnStart(event: unknown): void; onUsageUpdate(event: unknown): void };
    }) => {
      renderer.onTurnStart({ round, role });
      renderer.onUsageUpdate({
        role,
        usage: role === 'AUTHOR' ? { used: 1234, size: 200_000 } : { used: 4321, size: 200_000 },
      });
      return role === 'REVIEWER' ? 'APPROVED' : 'done';
    });

    const engine = createLoopEngine({ config: config(1) });
    await engine.run();
    const round = engine.getState().rounds.get(1);

    expect(round?.AUTHOR.usage).toMatchObject({ used: 1234, size: 200_000 });
    expect(round?.REVIEWER.usage).toMatchObject({ used: 4321, size: 200_000 });
  });

  it('continues with the same sessions when approval is reopened by an edited task', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const cfg = config(2) as ReturnType<typeof config> & {
      task: string;
      onApproved?: () => Promise<{ continue: boolean; feedback?: string }>;
    };
    cfg.task = 'first task';
    cfg.authorSettings.prompt = ({ round, feedback }: { round: number; feedback: string }) =>
      `author ${round} ${cfg.task} ${feedback}`;
    cfg.onApproved = vi
      .fn()
      .mockImplementationOnce(async () => {
        cfg.task = 'edited task';
        return { continue: true, feedback: 'task changed after approval' };
      })
      .mockResolvedValueOnce({ continue: false });

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : '',
    );

    const result = await createLoopEngine({ config: cfg }).run();

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(cfg.onApproved).toHaveBeenCalledTimes(2);
    expect(mocks.openRole).toHaveBeenCalledTimes(2);
    const authorTurns = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'AUTHOR');
    expect(authorTurns.map(([arg]) => arg.state)).toEqual([authorState, authorState]);
    expect(authorTurns[1]?.[0].prompt).toContain('edited task');
  });

  it('continues with the same sessions when approval is force-continued', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const cfg = config(1) as ReturnType<typeof config> & {
      onApproved?: () => Promise<{ continue: boolean; feedback?: string }>;
    };
    cfg.onApproved = vi
      .fn()
      .mockResolvedValueOnce({ continue: true, feedback: 'force another round' })
      .mockResolvedValueOnce({ continue: false });

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : '',
    );

    const result = await createLoopEngine({ config: cfg }).run();

    expect(result).toMatchObject({ approved: true, rounds: 2, maxRounds: 2 });
    expect(cfg.onApproved).toHaveBeenCalledTimes(2);
    const authorTurns = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'AUTHOR');
    expect(authorTurns.map(([arg]) => arg.state)).toEqual([authorState, authorState]);
    expect(authorTurns[1]?.[0].prompt).toContain('force another round');
  });

  it('caps repeated approval continuations to prevent runaway approval loops', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const cfg = {
      ...config(1),
      maxApprovalContinuations: 1,
      onApproved: vi.fn().mockResolvedValue({ continue: true, feedback: 'again' }),
    };

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : '',
    );

    const result = await createLoopEngine({ config: cfg }).run();

    expect(result).toMatchObject({
      approved: true,
      rounds: 2,
      maxRounds: 2,
      continuationLimitReached: true,
    });
    expect(cfg.onApproved).toHaveBeenCalledTimes(2);
    expect(mocks.runTurn).toHaveBeenCalledTimes(4);
  });
});
