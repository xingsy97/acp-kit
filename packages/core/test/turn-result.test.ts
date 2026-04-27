import { describe, expect, it, vi } from 'vitest';
import { collectTurnResult, type CollectedTurnResult } from '../src/turn-result.js';
import type { RuntimeEventHandlers } from '../src/runtime-event.js';
import type { RuntimeSessionEvent } from '../src/session.js';

function createSession(events: RuntimeSessionEvent[], reject?: unknown) {
  let handlers: RuntimeEventHandlers<RuntimeSessionEvent> | null = null;
  const unsubscribe = vi.fn(() => { handlers = null; });
  return {
    unsubscribe,
    session: {
      on(nextHandlers: RuntimeEventHandlers<RuntimeSessionEvent>) {
        handlers = nextHandlers;
        return unsubscribe;
      },
      async prompt() {
        for (const event of events) {
          const key = event.type.replace(/\.([a-z])/g, (_, char: string) => char.toUpperCase());
          const handler = handlers?.[key as keyof RuntimeEventHandlers<RuntimeSessionEvent>] as ((event: RuntimeSessionEvent) => void) | undefined;
          handler?.(event);
        }
        if (reject) throw reject;
        return { stopReason: 'end_turn' };
      },
    },
  };
}

describe('collectTurnResult', () => {
  it('streams updates and returns collected text and tools', async () => {
    const { session, unsubscribe } = createSession([
      { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'APP' },
      { type: 'tool.start', sessionId: 's1', at: 2, toolCallId: 't1', name: 'read', title: 'Read file', status: 'running', input: { text: 'abc' } },
      { type: 'tool.end', sessionId: 's1', at: 3, toolCallId: 't1', status: 'completed', output: { text: 'abcdef' } },
      { type: 'message.delta', sessionId: 's1', at: 4, messageId: 'm1', delta: 'ROVED' },
      { type: 'turn.completed', sessionId: 's1', at: 5, turnId: 'turn1', stopReason: 'end_turn' },
    ]);
    const updates: CollectedTurnResult[] = [];

    const result = await collectTurnResult(session as never, 'review', {
      onUpdate: (snapshot) => updates.push(snapshot),
    });

    expect(result.text).toBe('APPROVED');
    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('end_turn');
    expect(result.tools).toEqual([
      { id: 't1', tag: '#1', name: 'read', title: 'Read file', status: 'completed', inputChars: 3, outputChars: 6 },
    ]);
    expect(updates.map((update) => update.text)).toContain('APPROVED');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('unsubscribes when the prompt fails', async () => {
    const error = new Error('boom');
    const { session, unsubscribe } = createSession([
      { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'partial' },
      { type: 'turn.failed', sessionId: 's1', at: 2, turnId: 'turn1', error: 'boom' },
    ], error);

    await expect(collectTurnResult(session as never, 'review')).rejects.toThrow('boom');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});