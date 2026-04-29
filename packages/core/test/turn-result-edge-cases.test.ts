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

describe('collectTurnResult – edge cases', () => {
  it('returns empty text when no message deltas are emitted', async () => {
    const { session } = createSession([
      { type: 'turn.completed', sessionId: 's1', at: 1, turnId: 't1', stopReason: 'end_turn' },
    ]);

    const result = await collectTurnResult(session as never, 'do something');
    expect(result.text).toBe('');
    expect(result.tools).toEqual([]);
    expect(result.status).toBe('completed');
  });

  it('collects tools without any message text', async () => {
    const { session } = createSession([
      { type: 'tool.start', sessionId: 's1', at: 1, toolCallId: 't1', name: 'bash', title: 'Run bash', status: 'running', input: { text: 'ls' } },
      { type: 'tool.end', sessionId: 's1', at: 2, toolCallId: 't1', status: 'completed', output: { text: 'file1.ts\nfile2.ts' } },
      { type: 'turn.completed', sessionId: 's1', at: 3, turnId: 'turn1', stopReason: 'end_turn' },
    ]);

    const result = await collectTurnResult(session as never, 'list files');
    expect(result.text).toBe('');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toMatchObject({
      name: 'bash',
      title: 'Run bash',
      status: 'completed',
      inputChars: 2,
      outputChars: 17,
    });
  });

  it('counts chars in nested object input', async () => {
    const { session } = createSession([
      {
        type: 'tool.start',
        sessionId: 's1',
        at: 1,
        toolCallId: 't1',
        name: 'write',
        status: 'running',
        input: { path: '/a.ts', content: 'hello world' },
      },
      { type: 'tool.end', sessionId: 's1', at: 2, toolCallId: 't1', status: 'completed', output: { text: 'ok' } },
      { type: 'turn.completed', sessionId: 's1', at: 3, turnId: 'turn1', stopReason: 'end_turn' },
    ]);

    const result = await collectTurnResult(session as never, 'write file');
    // countChars({ path: '/a.ts', content: 'hello world' }) hits the
    // `record.content` string shortcut and returns 'hello world'.length = 11.
    expect(result.tools[0].inputChars).toBe(11);
    expect(result.tools[0].outputChars).toBe(2);
  });

  it('counts chars in array input', async () => {
    const { session } = createSession([
      {
        type: 'tool.start',
        sessionId: 's1',
        at: 1,
        toolCallId: 't1',
        name: 'multi',
        status: 'running',
        input: [{ text: 'aaa' }, { text: 'bb' }],
      },
      { type: 'tool.end', sessionId: 's1', at: 2, toolCallId: 't1', status: 'completed', output: null },
      { type: 'turn.completed', sessionId: 's1', at: 3, turnId: 'turn1', stopReason: 'end_turn' },
    ]);

    const result = await collectTurnResult(session as never, 'multi');
    expect(result.tools[0].inputChars).toBe(5);
    expect(result.tools[0].outputChars).toBe(0);
  });

  it('handles null/undefined input and output', async () => {
    const { session } = createSession([
      { type: 'tool.start', sessionId: 's1', at: 1, toolCallId: 't1', name: 'test', status: 'running', input: null },
      { type: 'tool.end', sessionId: 's1', at: 2, toolCallId: 't1', status: 'completed', output: undefined },
      { type: 'turn.completed', sessionId: 's1', at: 3, turnId: 'turn1', stopReason: 'end_turn' },
    ]);

    const result = await collectTurnResult(session as never, 'null test');
    expect(result.tools[0].inputChars).toBe(0);
    expect(result.tools[0].outputChars).toBe(0);
  });

  it('tracks multiple tools with sequential numbering', async () => {
    const { session } = createSession([
      { type: 'tool.start', sessionId: 's1', at: 1, toolCallId: 'a', name: 'read', status: 'running', input: {} },
      { type: 'tool.start', sessionId: 's1', at: 2, toolCallId: 'b', name: 'write', status: 'running', input: {} },
      { type: 'tool.end', sessionId: 's1', at: 3, toolCallId: 'a', status: 'completed', output: {} },
      { type: 'tool.end', sessionId: 's1', at: 4, toolCallId: 'b', status: 'completed', output: {} },
      { type: 'turn.completed', sessionId: 's1', at: 5, turnId: 'turn1', stopReason: 'end_turn' },
    ]);

    const result = await collectTurnResult(session as never, 'multi tool');
    expect(result.tools[0].tag).toBe('#1');
    expect(result.tools[1].tag).toBe('#2');
  });

  it('reports cancelled status on turn.cancelled', async () => {
    const error = new Error('cancelled by user');
    const { session } = createSession([
      { type: 'turn.cancelled', sessionId: 's1', at: 1, turnId: 'turn1', reason: 'user cancelled' },
    ], error);

    await expect(collectTurnResult(session as never, 'cancel test')).rejects.toThrow('cancelled by user');
  });

  it('rejects when an adapter emits session.error even if prompt resolves', async () => {
    const { session, unsubscribe } = createSession([
      { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'partial output' },
      { type: 'session.error', sessionId: 's1', at: 2, message: 'adapter lost connection' } as never,
      { type: 'turn.completed', sessionId: 's1', at: 3, turnId: 'turn1', stopReason: 'end_turn' },
    ]);
    const updates: CollectedTurnResult[] = [];

    await expect(collectTurnResult(session as never, 'unstable turn', {
      includeEvents: true,
      onUpdate: (snapshot) => updates.push(snapshot),
    })).rejects.toThrow('adapter lost connection');

    expect(updates.at(-1)).toMatchObject({
      text: 'partial output',
      status: 'failed',
      error: 'adapter lost connection',
      events: [
        expect.objectContaining({ type: 'message.delta' }),
        expect.objectContaining({ type: 'session.error' }),
        expect.objectContaining({ type: 'turn.completed' }),
      ],
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('calls onEvent callback with each event and snapshot', async () => {
    const { session } = createSession([
      { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'hi' },
      { type: 'turn.completed', sessionId: 's1', at: 2, turnId: 'turn1', stopReason: 'end_turn' },
    ]);

    const eventTypes: string[] = [];
    await collectTurnResult(session as never, 'event test', {
      onEvent: (event, snapshot) => {
        eventTypes.push(event.type);
        expect(snapshot).toBeDefined();
      },
    });

    expect(eventTypes).toContain('message.delta');
    expect(eventTypes).toContain('turn.completed');
  });

  it('collects events when includeEvents is true', async () => {
    const { session } = createSession([
      { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'x' },
      { type: 'turn.completed', sessionId: 's1', at: 2, turnId: 'turn1', stopReason: 'end_turn' },
    ]);

    const result = await collectTurnResult(session as never, 'include events', {
      includeEvents: true,
    });

    expect(result.events).toBeDefined();
    expect(result.events!.length).toBeGreaterThan(0);
  });

  it('events array is undefined when includeEvents is not set', async () => {
    const { session } = createSession([
      { type: 'turn.completed', sessionId: 's1', at: 1, turnId: 'turn1', stopReason: 'end_turn' },
    ]);

    const result = await collectTurnResult(session as never, 'no events');
    expect(result.events).toBeUndefined();
  });

  it('messageCompleted sets text when no deltas preceded it', async () => {
    const { session } = createSession([
      { type: 'message.completed', sessionId: 's1', at: 1, messageId: 'm1', content: 'completed directly' } as never,
      { type: 'turn.completed', sessionId: 's1', at: 2, turnId: 'turn1', stopReason: 'end_turn' },
    ]);

    const result = await collectTurnResult(session as never, 'completed test');
    expect(result.text).toBe('completed directly');
  });

  it('tool.end updates title when provided', async () => {
    const { session } = createSession([
      { type: 'tool.start', sessionId: 's1', at: 1, toolCallId: 't1', name: 'read', status: 'running', input: {} },
      { type: 'tool.end', sessionId: 's1', at: 2, toolCallId: 't1', status: 'completed', output: {}, title: 'Read file: a.ts' },
      { type: 'turn.completed', sessionId: 's1', at: 3, turnId: 'turn1', stopReason: 'end_turn' },
    ]);

    const result = await collectTurnResult(session as never, 'title test');
    expect(result.tools[0].title).toBe('Read file: a.ts');
  });

  it('counts chars in string output directly', async () => {
    const { session } = createSession([
      { type: 'tool.start', sessionId: 's1', at: 1, toolCallId: 't1', name: 'test', status: 'running', input: 'input string' },
      { type: 'tool.end', sessionId: 's1', at: 2, toolCallId: 't1', status: 'completed', output: 'output string' },
      { type: 'turn.completed', sessionId: 's1', at: 3, turnId: 'turn1', stopReason: 'end_turn' },
    ]);

    const result = await collectTurnResult(session as never, 'string count');
    expect(result.tools[0].inputChars).toBe(12);
    expect(result.tools[0].outputChars).toBe(13);
  });
});
