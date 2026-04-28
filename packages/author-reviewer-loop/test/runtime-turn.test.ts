import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectTurnResult: vi.fn(),
}));

vi.mock('@acp-kit/core', () => ({
  collectTurnResult: mocks.collectTurnResult,
}));

const { runTurn } = await import('../lib/runtime/turn.mjs');

describe('runtime turn adapter', () => {
  beforeEach(() => {
    mocks.collectTurnResult.mockReset();
  });

  it('emits turn failed and turn end when collection throws before an ACP failure event', async () => {
    const error = new Error('agent crashed');
    const renderer = {
      onTurnStart: vi.fn(),
      onTurnFailed: vi.fn(),
      onTurnEnd: vi.fn(),
    };
    mocks.collectTurnResult.mockRejectedValue(error);

    await expect(runTurn({
      round: 1,
      role: 'AUTHOR',
      state: { session: {} },
      prompt: 'do it',
      renderer,
    })).rejects.toThrow('agent crashed');

    expect(renderer.onTurnStart).toHaveBeenCalledWith(expect.objectContaining({ round: 1, role: 'AUTHOR' }));
    expect(renderer.onTurnFailed).toHaveBeenCalledWith(expect.objectContaining({ round: 1, role: 'AUTHOR', error: 'agent crashed' }));
    expect(renderer.onTurnEnd).toHaveBeenCalledWith(expect.objectContaining({ round: 1, role: 'AUTHOR' }));
  });

  it('does not duplicate turn failed when the ACP event already reported it', async () => {
    const error = new Error('collector stopped after ACP failure');
    const renderer = {
      onTurnStart: vi.fn(),
      onTurnFailed: vi.fn(),
      onTurnEnd: vi.fn(),
    };
    mocks.collectTurnResult.mockImplementation(async (_session, _prompt, { onEvent }) => {
      onEvent({ type: 'turn.failed', error: 'agent reported failure' }, {});
      throw error;
    });

    await expect(runTurn({
      round: 2,
      role: 'REVIEWER',
      state: { session: {} },
      prompt: 'review it',
      renderer,
    })).rejects.toThrow('collector stopped after ACP failure');

    expect(renderer.onTurnFailed).toHaveBeenCalledTimes(1);
    expect(renderer.onTurnFailed).toHaveBeenCalledWith(expect.objectContaining({ round: 2, role: 'REVIEWER', error: 'agent reported failure' }));
    expect(renderer.onTurnEnd).toHaveBeenCalledWith(expect.objectContaining({ round: 2, role: 'REVIEWER' }));
  });

  it('forwards tool update events', async () => {
    const renderer = {
      onTurnStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onTurnSnapshot: vi.fn(),
      onTurnEnd: vi.fn(),
    };
    mocks.collectTurnResult.mockImplementation(async (_session, _prompt, { onEvent }) => {
      onEvent({ type: 'tool.update', toolCallId: 'tool-1', status: 'running', title: 'Run command', output: 'partial' }, { tools: [{ id: 'tool-1', tag: '#1', title: 'Run command', inputChars: 3, outputChars: 7 }] });
      return { text: 'done', status: 'completed' };
    });

    await runTurn({ round: 1, role: 'REVIEWER', state: { session: {} }, prompt: 'review it', renderer });

    expect(renderer.onToolUpdate).toHaveBeenCalledWith({
      round: 1,
      role: 'REVIEWER',
      toolCallId: 'tool-1',
      tag: '#1',
      title: 'Run command',
      status: 'running',
      chars: 7,
      output: 'partial',
    });
  });

  it('forwards reasoning deltas and completion events', async () => {
    const renderer = {
      onTurnStart: vi.fn(),
      onReasoningDelta: vi.fn(),
      onReasoningCompleted: vi.fn(),
      onTurnSnapshot: vi.fn(),
      onTurnEnd: vi.fn(),
    };
    mocks.collectTurnResult.mockImplementation(async (_session, _prompt, { onEvent }) => {
      onEvent({ type: 'reasoning.delta', reasoningId: 'r1', delta: 'checking files' }, {});
      onEvent({ type: 'reasoning.completed', reasoningId: 'r1' }, {});
      return { text: 'done', status: 'completed' };
    });

    await runTurn({
      round: 1,
      role: 'AUTHOR',
      state: { session: {} },
      prompt: 'do it',
      renderer,
    });

    expect(renderer.onReasoningDelta).toHaveBeenCalledWith({ round: 1, role: 'AUTHOR', delta: 'checking files', reasoningId: 'r1' });
    expect(renderer.onReasoningCompleted).toHaveBeenCalledWith({ round: 1, role: 'AUTHOR', reasoningId: 'r1' });
  });
});
