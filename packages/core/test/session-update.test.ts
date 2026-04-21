import { describe, it, expect, vi } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { onSessionUpdate, SessionUpdateKind } from '../src/session-update.js';

describe('onSessionUpdate', () => {
  it('dispatches by camelCase key with narrowed types', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    };

    const onAgent = vi.fn();
    onSessionUpdate(update, { agentMessageChunk: onAgent });
    expect(onAgent).toHaveBeenCalledWith(update);
  });

  it('falls through to default when no handler matches', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'usage_update',
      usage: { input_tokens: 1, output_tokens: 2 } as never,
    };
    const def = vi.fn();
    const handled = vi.fn();
    onSessionUpdate(update, { agentMessageChunk: handled, default: def });
    expect(handled).not.toHaveBeenCalled();
    expect(def).toHaveBeenCalledWith(update);
  });

  it('returns the handler result', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'read file',
    } as SessionUpdate;
    const result = onSessionUpdate(update, {
      toolCall: (u) => `tool:${u.title}`,
    });
    expect(result).toBe('tool:read file');
  });

  it('SessionUpdateKind maps camelCase names to ACP literals', () => {
    expect(SessionUpdateKind.AgentMessageChunk).toBe('agent_message_chunk');
    expect(SessionUpdateKind.ToolCallUpdate).toBe('tool_call_update');
  });
});
