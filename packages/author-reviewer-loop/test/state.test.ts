import { describe, expect, it } from 'vitest';
import { PaneStatus, initialState, reduce } from '../lib/engine/state.mjs';

describe('author-reviewer-loop state reducer', () => {
  it('tolerates partial turn snapshots from runtimes', () => {
    const state = reduce(initialState(), {
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: {
        status: 'completed',
        usage: { inputTokens: 1 },
      },
    });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.status).toBe(PaneStatus.Completed);
    expect(pane?.lines).toEqual([]);
    expect(pane?.current).toBe('');
    expect(pane?.tools).toEqual([]);
    expect(pane?.chars).toBe(0);
  });

  it('normalizes missing tool character counts instead of producing NaN', () => {
    const state = reduce(initialState(), {
      type: 'turnSnapshot',
      round: 1,
      role: 'REVIEWER',
      snapshot: {
        text: 'APPROVED',
        status: 'completed',
        tools: [
          { id: 'tool-1', tag: '#1', name: 'shell', title: 'Shell' },
          { id: 'tool-2', tag: '#2', name: 'read', outputChars: 42 },
        ],
      },
    });

    const tools = state.rounds.get(1)?.REVIEWER.tools ?? [];
    expect(tools.map((tool) => tool.chars)).toEqual([0, 42]);
  });

  it('keeps tool events without ids separate instead of merging them together', () => {
    let state = initialState();
    state = reduce(state, {
      type: 'toolStart',
      flowId: 1,
      round: 1,
      role: 'AUTHOR',
      status: PaneStatus.Running,
      name: 'shell',
      title: 'First tool',
    });
    state = reduce(state, {
      type: 'toolStart',
      flowId: 2,
      round: 1,
      role: 'AUTHOR',
      status: PaneStatus.Running,
      name: 'read',
      title: 'Second tool',
    });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.tools.map((tool) => tool.id)).toEqual(['tool-event-1', 'tool-event-2']);
    expect(pane?.flow.filter((item) => item.kind === 'tool').map((item) => item.title)).toEqual([
      'First tool',
      'Second tool',
    ]);
  });

  it('preserves nonzero context usage when a later same-size snapshot reports zero used', () => {
    let state = initialState();
    state = reduce(state, {
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: { status: 'running', usage: { used: 1234, size: 200_000 } },
    });
    state = reduce(state, {
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: { status: 'running', usage: { used: 0, size: 200_000 } },
    });

    expect(state.rounds.get(1)?.AUTHOR.usage).toMatchObject({ used: 1234, size: 200_000 });
  });

  it('accepts zero context usage when the context size changes', () => {
    let state = initialState();
    state = reduce(state, {
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: { status: 'running', usage: { used: 1234, size: 200_000 } },
    });
    state = reduce(state, {
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: { status: 'running', usage: { used: 0, size: 100_000 } },
    });

    expect(state.rounds.get(1)?.AUTHOR.usage).toMatchObject({ used: 0, size: 100_000 });
  });

  it('does not double count live usage updates already included in the final turn snapshot', () => {
    let state = initialState();
    state = reduce(state, { type: 'turnStart', round: 1, role: 'AUTHOR' });
    state = reduce(state, {
      type: 'usageUpdate',
      role: 'AUTHOR',
      usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
    });
    state = reduce(state, {
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: {
        status: 'completed',
        usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      },
    });

    expect(state.usage.AUTHOR).toMatchObject({ inputTokens: 100, outputTokens: 25, totalTokens: 125 });
    expect(state.rounds.get(1)?.AUTHOR.usage).toMatchObject({ inputTokens: 100, outputTokens: 25, totalTokens: 125 });
  });

  it('merges partial live usage updates for the active turn', () => {
    let state = initialState();
    state = reduce(state, { type: 'turnStart', round: 1, role: 'REVIEWER' });
    state = reduce(state, {
      type: 'usageUpdate',
      role: 'REVIEWER',
      usage: { inputTokens: 20 },
    });
    state = reduce(state, {
      type: 'usageUpdate',
      role: 'REVIEWER',
      usage: { outputTokens: 5, totalTokens: 25 },
    });

    expect(state.usage.REVIEWER).toMatchObject({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
    expect(state.rounds.get(1)?.REVIEWER.turnUsage).toMatchObject({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
  });

  it('bounds retained trace entries by approximate serialized size', () => {
    let state = initialState();
    for (let index = 0; index < 30; index += 1) {
      state = reduce(state, {
        type: 'traceEntry',
        traceId: index + 1,
        role: 'AUTHOR',
        entry: {
          kind: 'wire',
          at: index,
          direction: 'sent',
          frame: { payload: 'x'.repeat(100_000) },
        },
      });
    }

    expect(state.trace.length).toBeGreaterThan(0);
    expect(JSON.stringify(state.trace).length).toBeLessThan(1_000_000);
    expect(state.trace.at(-1)?.entry.frame).toContain('omitted');
  });
});
