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

  it('always emits turn end when collection fails', async () => {
    const error = new Error('agent crashed');
    const renderer = {
      onTurnStart: vi.fn(),
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

    expect(renderer.onTurnStart).toHaveBeenCalledWith({ round: 1, role: 'AUTHOR' });
    expect(renderer.onTurnEnd).toHaveBeenCalledWith({ round: 1, role: 'AUTHOR' });
  });
});
