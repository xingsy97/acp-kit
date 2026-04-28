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
