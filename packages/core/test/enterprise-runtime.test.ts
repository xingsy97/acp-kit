import { describe, expect, it, vi } from 'vitest';

import {
  createRuntimeReplay,
  loadRuntimeReplay,
  PermissionDecision,
  replayRuntimeEvents,
  type RuntimeSessionEvent,
  type RuntimeStoreEntry,
} from '../src/index.js';

describe('enterprise runtime helpers', () => {
  it('replays runtime events through handler maps', () => {
    const events: RuntimeSessionEvent[] = [
      {
        type: 'message.delta',
        sessionId: 'session-1',
        at: 1,
        messageId: 'message-1',
        delta: 'hello',
      },
      {
        type: 'message.completed',
        sessionId: 'session-1',
        at: 2,
        messageId: 'message-1',
        content: 'hello',
      },
      {
        type: 'turn.completed',
        sessionId: 'session-1',
        at: 3,
        turnId: 'turn-1',
        stopReason: 'end_turn',
      },
    ];

    const seen: string[] = [];
    const results = replayRuntimeEvents(events, {
      messageDelta: (event) => seen.push(event.delta),
      turnCompleted: (event) => seen.push(event.stopReason ?? 'unknown'),
    });

    expect(seen).toEqual(['hello', 'end_turn']);
    expect(results).toHaveLength(3);
  });

  it('builds transcript state from replayed runtime events', () => {
    const replay = createRuntimeReplay([
      {
        type: 'message.delta',
        sessionId: 'session-1',
        at: 1,
        messageId: 'message-1',
        delta: 'hel',
      },
      {
        type: 'message.delta',
        sessionId: 'session-1',
        at: 2,
        messageId: 'message-1',
        delta: 'lo',
      },
      {
        type: 'message.completed',
        sessionId: 'session-1',
        at: 3,
        messageId: 'message-1',
        content: 'hello',
      },
    ]);

    expect(replay.transcript.blocks).toEqual([
      expect.objectContaining({ kind: 'message', content: 'hello', completed: true }),
    ]);
  });

  it('loads replay events from an event store', async () => {
    const entries: RuntimeStoreEntry[] = [
      {
        kind: 'observation',
        at: 1,
        runtimeId: 'runtime-1',
        agentId: 'test',
        observation: {
          type: 'runtime.connect.started',
          at: 1,
          runtimeId: 'runtime-1',
          agentId: 'test',
        },
      },
      {
        kind: 'session.event',
        at: 2,
        runtimeId: 'runtime-1',
        agentId: 'test',
        sessionId: 'session-1',
        event: {
          type: 'message.delta',
          sessionId: 'session-1',
          at: 2,
          messageId: 'message-1',
          delta: 'stored',
        },
      },
    ];

    const replay = await loadRuntimeReplay({
      append: vi.fn(),
      load: async (query) => entries.filter((entry) => !query?.kind || entry.kind === query.kind),
    }, { runtimeId: 'runtime-1', sessionId: 'session-1' });

    expect(replay.events).toHaveLength(1);
    expect(replay.transcript.blocks[0]?.content).toBe('stored');
  });

  it('exports permission decisions for approval queue decisions', () => {
    expect(PermissionDecision.AllowOnce).toBe('allow_once');
    expect(PermissionDecision.Deny).toBe('deny');
  });
});
