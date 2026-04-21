import { describe, it, expect, vi } from 'vitest';
import type { RuntimeEvent } from '../src/events.js';
import { onRuntimeEvent, RuntimeEventKind } from '../src/runtime-event.js';

describe('onRuntimeEvent', () => {
  it('dispatches by camelCase key with narrowed types', () => {
    const event: RuntimeEvent = {
      type: 'message.delta',
      sessionId: 's1',
      at: 0,
      messageId: 'm1',
      delta: 'hello',
    };
    const onDelta = vi.fn();
    onRuntimeEvent(event, { messageDelta: onDelta });
    expect(onDelta).toHaveBeenCalledWith(event);
  });

  it('handles multi-segment dotted types (session.commands.updated)', () => {
    const event: RuntimeEvent = {
      type: 'session.commands.updated',
      sessionId: 's1',
      at: 0,
      commands: [],
    };
    const fn = vi.fn();
    onRuntimeEvent(event, { sessionCommandsUpdated: fn });
    expect(fn).toHaveBeenCalledWith(event);
  });

  it('falls through to default when no handler matches', () => {
    const event: RuntimeEvent = {
      type: 'tool.start',
      sessionId: 's1',
      at: 0,
      toolCallId: 't1',
      name: 'read',
      status: 'running',
    };
    const def = vi.fn();
    const handled = vi.fn();
    onRuntimeEvent(event, { messageDelta: handled, default: def });
    expect(handled).not.toHaveBeenCalled();
    expect(def).toHaveBeenCalledWith(event);
  });

  it('returns the handler result', () => {
    const event: RuntimeEvent = {
      type: 'tool.end',
      sessionId: 's1',
      at: 0,
      toolCallId: 't1',
      status: 'completed',
    };
    const result = onRuntimeEvent(event, {
      toolEnd: (e) => `done:${e.toolCallId}:${e.status}`,
    });
    expect(result).toBe('done:t1:completed');
  });

  it('RuntimeEventKind maps camelCase names to dotted literals', () => {
    expect(RuntimeEventKind.ToolStart).toBe('tool.start');
    expect(RuntimeEventKind.SessionCommandsUpdated).toBe('session.commands.updated');
  });
});
