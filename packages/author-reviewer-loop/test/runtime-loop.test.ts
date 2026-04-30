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
      onReasoningDelta: vi.fn(),
      onReasoningCompleted: vi.fn(),
      onTurnSnapshot: vi.fn(),
      onToolUpdate: vi.fn(),
      onTraceEntry: vi.fn(),
      onUsageUpdate: vi.fn(),
      onApprovalPending: vi.fn(),
      onApprovalContinued: vi.fn(),
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
        type: 'reasoningDelta',
        round: 1,
        role: 'AUTHOR',
        delta: 'thinking',
        reasoningId: 'r1',
      });
      listener({
        type: 'reasoningCompleted',
        round: 1,
        role: 'AUTHOR',
        reasoningId: 'r1',
        content: 'thinking',
      });
      listener({
        type: 'toolUpdate',
        round: 1,
        role: 'AUTHOR',
        toolCallId: 'tool-1',
        status: 'running',
        output: 'partial',
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
      listener({
        type: 'approvalPending',
        result: { approved: true, rounds: 1 },
      });
      listener({
        type: 'approvalContinued',
        round: 1,
        feedback: 'force another round',
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
    expect(renderer.onReasoningDelta).toHaveBeenCalledWith({
      type: 'reasoningDelta',
      round: 1,
      role: 'AUTHOR',
      delta: 'thinking',
      reasoningId: 'r1',
    });
    expect(renderer.onReasoningCompleted).toHaveBeenCalledWith({
      type: 'reasoningCompleted',
      round: 1,
      role: 'AUTHOR',
      reasoningId: 'r1',
      content: 'thinking',
    });
    expect(renderer.onToolUpdate).toHaveBeenCalledWith({
      type: 'toolUpdate',
      round: 1,
      role: 'AUTHOR',
      toolCallId: 'tool-1',
      status: 'running',
      output: 'partial',
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
    expect(renderer.onApprovalPending).toHaveBeenCalledWith({ approved: true, rounds: 1 });
    expect(renderer.onApprovalContinued).toHaveBeenCalledWith({
      type: 'approvalContinued',
      round: 1,
      feedback: 'force another round',
    });
  });
});
