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

  it('treats session.error as a terminal user-visible turn failure', async () => {
    const error = new Error('adapter lost connection');
    const renderer = {
      onTurnStart: vi.fn(),
      onTurnFailed: vi.fn(),
      onTurnEnd: vi.fn(),
    };
    mocks.collectTurnResult.mockImplementation(async (_session, _prompt, { onEvent }) => {
      onEvent({ type: 'session.error', message: 'adapter lost connection', at: 123 }, {});
      throw error;
    });

    await expect(runTurn({
      round: 3,
      role: 'AUTHOR',
      state: { session: {} },
      prompt: 'continue after disconnect',
      renderer,
    })).rejects.toThrow('adapter lost connection');

    expect(renderer.onTurnFailed).toHaveBeenCalledTimes(1);
    expect(renderer.onTurnFailed).toHaveBeenCalledWith({
      round: 3,
      role: 'AUTHOR',
      error: 'adapter lost connection',
      at: 123,
    });
    expect(renderer.onTurnEnd).toHaveBeenCalledWith(expect.objectContaining({ round: 3, role: 'AUTHOR' }));
  });

  it('still fails the turn when a collector resolves after session.error', async () => {
    const renderer = {
      onTurnStart: vi.fn(),
      onTurnFailed: vi.fn(),
      onTurnSnapshot: vi.fn(),
      onTurnEnd: vi.fn(),
    };
    mocks.collectTurnResult.mockImplementation(async (_session, _prompt, { onEvent }) => {
      onEvent({ type: 'session.error', message: 'adapter lost connection', at: 321 }, {});
      return { text: 'stale success', status: 'completed', stopReason: 'end_turn' };
    });

    await expect(runTurn({
      round: 6,
      role: 'AUTHOR',
      state: { session: {} },
      prompt: 'recover after disconnect',
      renderer,
    })).rejects.toThrow('adapter lost connection');

    expect(renderer.onTurnFailed).toHaveBeenCalledTimes(1);
    expect(renderer.onTurnSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      round: 6,
      role: 'AUTHOR',
      snapshot: expect.objectContaining({ text: 'stale success', status: 'completed' }),
    }));
    expect(renderer.onTurnEnd).toHaveBeenCalledWith(expect.objectContaining({ round: 6, role: 'AUTHOR' }));
  });

  it('still fails the turn when a collector resolves after turn.cancelled', async () => {
    const renderer = {
      onTurnStart: vi.fn(),
      onTurnFailed: vi.fn(),
      onTurnSnapshot: vi.fn(),
      onTurnEnd: vi.fn(),
    };
    mocks.collectTurnResult.mockImplementation(async (_session, _prompt, { onEvent }) => {
      onEvent({ type: 'turn.cancelled', reason: 'user cancelled', at: 654 }, {});
      return { text: 'partial draft', status: 'cancelled', error: 'user cancelled' };
    });

    await expect(runTurn({
      round: 7,
      role: 'REVIEWER',
      state: { session: {} },
      prompt: 'cancel review',
      renderer,
    })).rejects.toThrow('user cancelled');

    expect(renderer.onTurnFailed).toHaveBeenCalledTimes(1);
    expect(renderer.onTurnFailed).toHaveBeenCalledWith({
      round: 7,
      role: 'REVIEWER',
      error: 'user cancelled',
      at: 654,
    });
    expect(renderer.onTurnSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      round: 7,
      role: 'REVIEWER',
      snapshot: expect.objectContaining({ status: 'cancelled', error: 'user cancelled' }),
    }));
    expect(renderer.onTurnEnd).toHaveBeenCalledWith(expect.objectContaining({ round: 7, role: 'REVIEWER' }));
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
      onEvent({ type: 'reasoning.completed', reasoningId: 'r1', content: 'checking files' }, {});
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
    expect(renderer.onReasoningCompleted).toHaveBeenCalledWith({ round: 1, role: 'AUTHOR', reasoningId: 'r1', content: 'checking files' });
  });

  it('ignores malformed runtime events from collectors', async () => {
    const renderer = {
      onTurnStart: vi.fn(),
      onTurnSnapshot: vi.fn(),
      onTurnEnd: vi.fn(),
      onTurnFailed: vi.fn(),
    };
    mocks.collectTurnResult.mockImplementation(async (_session, _prompt, { onEvent }) => {
      onEvent(null, {});
      onEvent(undefined, {});
      return { text: 'done', status: 'completed' };
    });

    await expect(runTurn({
      round: 1,
      role: 'AUTHOR',
      state: { session: {} },
      prompt: 'do it',
      renderer,
    })).resolves.toBe('done');

    expect(renderer.onTurnFailed).not.toHaveBeenCalled();
    expect(renderer.onTurnEnd).toHaveBeenCalledWith(expect.objectContaining({ round: 1, role: 'AUTHOR' }));
  });

  it('keeps users informed when a tool end arrives without a matching start event', async () => {
    const renderer = {
      onTurnStart: vi.fn(),
      onToolEnd: vi.fn(),
      onTurnSnapshot: vi.fn(),
      onTurnEnd: vi.fn(),
    };
    mocks.collectTurnResult.mockImplementation(async (_session, _prompt, { onEvent }) => {
      onEvent(
        { type: 'tool.end', toolCallId: 'late-tool', status: 'failed', title: 'Apply patch', output: { text: 'disk full' } },
        { tools: [{ id: 'late-tool', tag: '#1', title: 'Apply patch', inputChars: 0, outputChars: 9 }] },
      );
      return { text: 'could not finish', status: 'failed', error: 'disk full' };
    });

    await runTurn({ round: 4, role: 'AUTHOR', state: { session: {} }, prompt: 'patch files', renderer });

    expect(renderer.onToolEnd).toHaveBeenCalledWith({
      round: 4,
      role: 'AUTHOR',
      toolCallId: 'late-tool',
      tag: '#1',
      title: 'Apply patch',
      status: 'failed',
      chars: 9,
      output: { text: 'disk full' },
    });
    expect(renderer.onTurnSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      round: 4,
      role: 'AUTHOR',
      snapshot: expect.objectContaining({ error: 'disk full' }),
    }));
  });

  it('forwards ACP tool locations and structured content to renderer callbacks', async () => {
    const renderer = {
      onTurnStart: vi.fn(),
      onToolStart: vi.fn(),
      onToolUpdate: vi.fn(),
      onToolEnd: vi.fn(),
      onTurnSnapshot: vi.fn(),
      onTurnEnd: vi.fn(),
    };
    const locations = [{ path: '/repo/src/index.ts', line: 42 }];
    const content = [{ type: 'content', content: { type: 'text', text: 'patch applied' } }];
    mocks.collectTurnResult.mockImplementation(async (_session, _prompt, { onEvent }) => {
      onEvent(
        { type: 'tool.start', toolCallId: 't1', name: 'edit', title: 'Edit file', kind: 'edit', input: { path: '/x' }, locations, content },
        { tools: [{ id: 't1', tag: '#1', title: 'Edit file', inputChars: 1, outputChars: 0 }] },
      );
      onEvent(
        { type: 'tool.update', toolCallId: 't1', status: 'in_progress', locations, content },
        { tools: [{ id: 't1', tag: '#1', title: 'Edit file', inputChars: 1, outputChars: 0 }] },
      );
      onEvent(
        { type: 'tool.end', toolCallId: 't1', status: 'completed', output: { text: 'ok' }, locations, content },
        { tools: [{ id: 't1', tag: '#1', title: 'Edit file', inputChars: 1, outputChars: 2 }] },
      );
      return { text: 'done', status: 'completed' };
    });

    await runTurn({ round: 5, role: 'AUTHOR', state: { session: {} }, prompt: 'edit', renderer });

    expect(renderer.onToolStart).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: 't1', kind: 'edit', locations, content,
    }));
    expect(renderer.onToolUpdate).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: 't1', status: 'in_progress', locations, content,
    }));
    expect(renderer.onToolEnd).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: 't1', status: 'completed', locations, content,
    }));
  });
});
