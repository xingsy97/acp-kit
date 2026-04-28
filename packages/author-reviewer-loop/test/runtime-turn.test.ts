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

    expect(renderer.onTurnStart).toHaveBeenCalledWith({ round: 1, role: 'AUTHOR' });
    expect(renderer.onTurnFailed).toHaveBeenCalledWith({ round: 1, role: 'AUTHOR', error: 'agent crashed' });
    expect(renderer.onTurnEnd).toHaveBeenCalledWith({ round: 1, role: 'AUTHOR' });
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
    expect(renderer.onTurnFailed).toHaveBeenCalledWith({ round: 2, role: 'REVIEWER', error: 'agent reported failure' });
    expect(renderer.onTurnEnd).toHaveBeenCalledWith({ round: 2, role: 'REVIEWER' });
  });
});
