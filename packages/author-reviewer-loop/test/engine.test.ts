import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  openRole: vi.fn(),
  closeRole: vi.fn(),
  runTurn: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: { mkdir: mocks.mkdir },
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
    mocks.mkdir.mockReset();
    mocks.openRole.mockReset();
    mocks.closeRole.mockReset();
    mocks.runTurn.mockReset();
    mocks.mkdir.mockResolvedValue(undefined);
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

  it('rejects approval-shaped reviewer hallucinations before accepting a standalone verdict', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewerReplies = [
      'The README says "APPROVED" but tests are failing.',
      '- APPROVED if you ignore the broken edge case.',
      'APPROVED\nAll production checks pass.',
    ];
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? reviewerReplies[round - 1] : '',
    );

    const result = await createLoopEngine({ config: config(3) }).run();

    expect(result).toMatchObject({
      approved: true,
      rounds: 3,
      feedback: 'APPROVED\nAll production checks pass.',
    });
    expect(mocks.runTurn).toHaveBeenCalledTimes(6);
  });

  it('treats contradictory APPROVED replies as not approved until the reviewer sends a clean verdict', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewerReplies = [
      'APPROVED\n1. Remaining issue: restart recovery is still broken.',
      'APPROVED\nRestart recovery verified after a clean rerun.',
    ];
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? reviewerReplies[round - 1] : '',
    );

    const result = await createLoopEngine({ config: config(2) }).run();
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('treated as NOT APPROVED because it mixed APPROVED with conflicting issue text');
  });

  it('treats prose contradictions after APPROVED as not approved until the reviewer sends a clean verdict', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewerReplies = [
      'APPROVED\nHowever, restart recovery still fails on Windows.',
      'APPROVED\nRestart recovery verified after a clean rerun.',
    ];
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) =>
      role === 'REVIEWER' ? reviewerReplies[round - 1] : '',
    );

    const result = await createLoopEngine({ config: config(2) }).run();
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('However, restart recovery still fails on Windows.');
  });

  it('captures wire traces in TUI mode even when trace logging is disabled', async () => {
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
      captureTrace: true,
    }));
    expect(mocks.openRole).toHaveBeenCalledWith(expect.objectContaining({
      role: 'REVIEWER',
      trace: false,
      captureTrace: true,
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

  it('reports both startup failures when author and reviewer cannot launch', async () => {
    const authorError = new Error('AUTHOR agent missing dependency');
    const reviewerError = new Error('REVIEWER auth expired');
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) => {
      throw role === 'AUTHOR' ? authorError : reviewerError;
    });

    const thrown = await createLoopEngine({ config: config(1) }).run().catch((error) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.message).toBe('Role startup failed.');
    expect(thrown.errors.map((error: Error) => error.message)).toEqual(expect.arrayContaining([
      'AUTHOR agent missing dependency',
      'REVIEWER auth expired',
    ]));
    expect(mocks.runTurn).not.toHaveBeenCalled();
  });

  it('records a normal engine error when workspace creation fails before launch', async () => {
    mocks.mkdir.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

    const engine = createLoopEngine({ config: config(1) });
    await expect(engine.run()).rejects.toThrow('ENOSPC');

    expect(mocks.openRole).not.toHaveBeenCalled();
    expect(engine.getState()).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('ENOSPC'),
    });
  });

  it('preserves the original run failure while still closing both roles when cleanup also fails', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const reviewError = new Error('review failed');
    const closeError = new Error('author close failed');
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) => {
      if (role === 'AUTHOR') return 'draft';
      throw reviewError;
    });
    mocks.closeRole.mockImplementation(async (state: { role: string }) => {
      if (state === authorState) throw closeError;
    });

    const thrown = await createLoopEngine({ config: config(2) }).run().catch((error) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.message).toBe('Author-reviewer loop failed and cleanup also failed.');
    expect(thrown.errors.map((error: Error) => error.message)).toEqual(expect.arrayContaining([
      'review failed',
      'author close failed',
    ]));
    expect(mocks.closeRole).toHaveBeenCalledWith(authorState);
    expect(mocks.closeRole).toHaveBeenCalledWith(reviewerState);
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

  it('publishes tool update events into pane state and event subscribers', async () => {
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
      renderer: { onToolStart(event: unknown): void; onToolUpdate(event: unknown): void };
    }) => {
      if (role === 'REVIEWER') return 'APPROVED';
      renderer.onToolStart({ round, role, toolCallId: 'tool-1', tag: '#1', title: 'Run command' });
      renderer.onToolUpdate({ round, role, toolCallId: 'tool-1', tag: '#1', title: 'Run command', status: 'running', output: 'partial', chars: 7 });
      return 'done';
    });

    const engine = createLoopEngine({ config: config(1) });
    const events: string[] = [];
    engine.onEvent((event: { type: string }) => events.push(event.type));
    await engine.run();

    expect(events).toContain('toolUpdate');
    expect(engine.getState().rounds.get(1)?.AUTHOR.tools[0]).toMatchObject({
      id: 'tool-1',
      status: 'running',
      output: 'partial',
      chars: 7,
    });
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

  it('does not publish a terminal result until approval continuation is resolved', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    let resolveApproval;
    let markApprovalPending;
    const approvalPending = new Promise<void>((resolve) => {
      markApprovalPending = resolve;
    });
    const cfg = config(1) as ReturnType<typeof config> & {
      onApproved?: () => Promise<{ continue: boolean; feedback?: string }>;
    };
    cfg.onApproved = vi.fn().mockImplementation(() => {
      markApprovalPending?.();
      return new Promise((resolve) => {
        resolveApproval = resolve;
      });
    });

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'REVIEWER' ? 'APPROVED' : '',
    );

    const engine = createLoopEngine({ config: cfg });
    const results: unknown[] = [];
    engine.onEvent((event: { type: string; result?: unknown }) => {
      if (event.type === 'result') results.push(event.result);
    });

    const runPromise = engine.run();
    await approvalPending;

    expect(results).toEqual([]);
    expect(engine.getState().phase).not.toBe('done');

    resolveApproval?.({ continue: false });

    await expect(runPromise).resolves.toMatchObject({ approved: true, rounds: 1 });
    expect(results).toHaveLength(1);
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

  it('keeps the full user-visible flow when contradictory reviews eventually converge', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const cfg = config(4);
    cfg.authorSettings.prompt = ({ round, feedback }: { round: number; feedback: string }) =>
      `round=${round}\nprevious-review=${feedback || '<none>'}`;
    cfg.reviewerSettings.prompt = ({ round, feedback, authorReply }: { round: number; feedback: string; authorReply: string }) =>
      `review round=${round}\nprevious-review=${feedback || '<none>'}\nauthor=${authorReply}`;

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round, prompt, renderer }: {
      role: 'AUTHOR' | 'REVIEWER';
      round: number;
      prompt: string;
      renderer: { onMessageDelta(event: unknown): void; onToolStart(event: unknown): void; onToolEnd(event: unknown): void };
    }) => {
      if (role === 'AUTHOR') {
        renderer.onMessageDelta({ round, role, delta: `implemented-${round}` });
        return `implementation ${round} using ${prompt}`;
      }
      renderer.onToolStart({ round, role, toolCallId: `review-${round}`, tag: '#1', title: 'Run verification' });
      renderer.onToolEnd({ round, role, toolCallId: `review-${round}`, tag: '#1', title: 'Run verification', status: 'completed', output: 'ok', chars: 2 });
      if (round === 1) return 'Fix A immediately. Do not change B.';
      if (round === 2) return 'Contradiction: revert A and change B instead.';
      return 'APPROVED\nVerified after resolving contradictory review guidance.';
    });

    const engine = createLoopEngine({ config: cfg });
    const eventTypes: string[] = [];
    engine.onEvent((event: { type: string }) => eventTypes.push(event.type));
    const result = await engine.run();
    const authorPrompts = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'AUTHOR').map(([arg]) => arg.prompt);

    expect(result).toMatchObject({ approved: true, rounds: 3 });
    expect(authorPrompts[1]).toContain('Fix A immediately. Do not change B.');
    expect(authorPrompts[2]).toContain('Contradiction: revert A and change B instead.');
    expect(eventTypes).toEqual(expect.arrayContaining(['launching', 'delta', 'toolStart', 'toolEnd', 'result']));
    expect(engine.getState().rounds.get(3)?.REVIEWER.tools[0]).toMatchObject({
      id: 'review-3',
      status: 'completed',
      output: 'ok',
    });
  });

  it('exhausts maxRounds with repeated empty author output and rejection feedback', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    const cfg = config(3);
    cfg.authorSettings.prompt = ({ round, feedback }: { round: number; feedback: string }) =>
      `round=${round}; recover-from=${feedback || '<none>'}`;

    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) => {
      if (role === 'AUTHOR') return round === 1 ? '' : 'still no durable fix';
      return `REJECTED round ${round}: missing restart recovery and tests.`;
    });

    const result = await createLoopEngine({ config: cfg }).run();
    const authorPrompts = mocks.runTurn.mock.calls.filter(([arg]) => arg.role === 'AUTHOR').map(([arg]) => arg.prompt);

    expect(result).toMatchObject({
      approved: false,
      rounds: 3,
      maxRounds: 3,
      feedback: 'REJECTED round 3: missing restart recovery and tests.',
    });
    expect(authorPrompts[1]).toContain('REJECTED round 1');
    expect(authorPrompts[2]).toContain('REJECTED round 2');
    expect(mocks.runTurn).toHaveBeenCalledTimes(6);
  });

  it('replaces empty reviewer replies with explicit recovery feedback', async () => {
    const authorState = { role: 'AUTHOR', session: { id: 'author-session' } };
    const reviewerState = { role: 'REVIEWER', session: { id: 'reviewer-session' } };
    mocks.openRole.mockImplementation(async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) =>
      role === 'AUTHOR' ? authorState : reviewerState,
    );
    mocks.runTurn.mockImplementation(async ({ role, round }: { role: 'AUTHOR' | 'REVIEWER'; round: number }) => {
      if (role === 'AUTHOR') return round === 1 ? 'draft' : 'reworked draft';
      return round === 1 ? ' \n\t ' : 'APPROVED';
    });

    const result = await createLoopEngine({ config: config(2) }).run();
    const secondAuthorPrompt = mocks.runTurn.mock.calls.find(([arg]) => arg.role === 'AUTHOR' && arg.round === 2)?.[0].prompt;

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(secondAuthorPrompt).toContain('Reviewer returned an empty response.');
    expect(secondAuthorPrompt).toContain('Do not assume approval.');
  });
});
