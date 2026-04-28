import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: {
    onEvent: vi.fn(),
    run: vi.fn(),
  },
  createLoopEngine: vi.fn(),
}));

vi.mock('../lib/engine.mjs', () => ({
  createLoopEngine: mocks.createLoopEngine,
}));

const { runAuthorReviewerLoop } = await import('../lib/runtime/loop.mjs');

describe('author-reviewer-loop legacy runtime adapter', () => {
  it('forwards stateful engine events to legacy renderers', async () => {
    const renderer = {
      onTurnSnapshot: vi.fn(),
      onTraceEntry: vi.fn(),
      onUsageUpdate: vi.fn(),
    };
    const result = { approved: true };
    mocks.engine.onEvent.mockImplementation((listener: (event: unknown) => void) => {
      listener({
        type: 'turnSnapshot',
        round: 1,
        role: 'AUTHOR',
        snapshot: { text: 'draft', status: 'running' },
      });
      listener({
        type: 'traceEntry',
        role: 'AUTHOR',
        entry: { direction: 'sent' },
      });
      listener({
        type: 'usageUpdate',
        role: 'AUTHOR',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      });
    });
    mocks.engine.run.mockResolvedValue(result);
    mocks.createLoopEngine.mockReturnValue(mocks.engine);

    await expect(runAuthorReviewerLoop({ config: { cwd: process.cwd() }, renderer })).resolves.toBe(result);

    expect(renderer.onTurnSnapshot).toHaveBeenCalledWith({
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: { text: 'draft', status: 'running' },
    });
    expect(renderer.onTraceEntry).toHaveBeenCalledWith({
      type: 'traceEntry',
      role: 'AUTHOR',
      entry: { direction: 'sent' },
    });
    expect(renderer.onUsageUpdate).toHaveBeenCalledWith({
      type: 'usageUpdate',
      role: 'AUTHOR',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
  });
});
