import { describe, expect, it } from 'vitest';

import {
  normalizeAcpUpdate,
} from '../src/index.js';

describe('normalizeAcpUpdate – edge cases', () => {
  const ctx = { sessionId: 'session-1', turnId: 'turn-1', messageId: 'msg-1', reasoningId: 'reason-1' };

  it('returns empty array for unknown sessionUpdate types', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'unknown_type' } } as never,
      ctx,
    );
    expect(events).toEqual([]);
  });

  it('returns empty array when sessionUpdate is missing', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: {} } as never,
      ctx,
    );
    expect(events).toEqual([]);
  });

  it('drops agent_message_chunk with empty text', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } } } as never,
      ctx,
    );
    expect(events).toEqual([]);
  });

  it('drops agent_thought_chunk with empty text', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } } } as never,
      ctx,
    );
    expect(events).toEqual([]);
  });

  it('extracts text from string content directly', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: 'raw string' } } as never,
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'message.delta', delta: 'raw string' });
  });

  it('handles content with non-text object (no text field)', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', url: 'x' } } } as never,
      ctx,
    );
    expect(events).toEqual([]);
  });

  it('drops tool_call with missing toolCallId', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', status: 'pending' } } as never,
      ctx,
    );
    expect(events).toEqual([]);
  });

  it('drops tool_call with empty string toolCallId', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', toolCallId: '', status: 'pending' } } as never,
      ctx,
    );
    expect(events).toEqual([]);
  });

  it('drops tool_call_update with missing toolCallId', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'tool_call_update', status: 'completed' } } as never,
      ctx,
    );
    expect(events).toEqual([]);
  });

  it('normalizes all tool status variants', () => {
    const statuses = [
      { input: 'completed', expected: 'completed' },
      { input: 'success', expected: 'completed' },
      { input: 'error', expected: 'failed' },
      { input: 'failed', expected: 'failed' },
      { input: 'running', expected: 'running' },
      { input: 'in_progress', expected: 'running' },
      { input: 'in-progress', expected: 'running' },
      { input: 'pending', expected: 'pending' },
      { input: '', expected: 'pending' },
      { input: 'weird-status', expected: 'pending' },
      { input: undefined, expected: 'pending' },
    ];

    for (const { input, expected } of statuses) {
      const events = normalizeAcpUpdate(
        { sessionId: 'session-1', update: { sessionUpdate: 'tool_call', toolCallId: `tool-${input}`, status: input } } as never,
        ctx,
      );
      expect(events[0]).toMatchObject({ status: expected });
    }
  });

  it('emits tool.update for running tool_call_update', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'running' } } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({ type: 'tool.update', status: 'running' });
  });

  it('emits tool.end for failed tool_call_update', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'error' } } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({ type: 'tool.end', status: 'failed' });
  });

  it('reads toolName from _meta.claudeCode.toolName as fallback', () => {
    const events = normalizeAcpUpdate(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-meta',
          status: 'pending',
          _meta: { claudeCode: { toolName: 'Bash' } },
        },
      } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({ name: 'Bash' });
  });

  it('falls back to "tool" when no name source is available', () => {
    const events = normalizeAcpUpdate(
      {
        sessionId: 'session-1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'tool-noname', status: 'pending' },
      } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({ name: 'tool' });
  });

  it('reads tool input from _meta.claudeCode.input as fallback', () => {
    const events = normalizeAcpUpdate(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-input',
          status: 'pending',
          _meta: { claudeCode: { input: { cmd: 'ls' } } },
        },
      } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({ input: { cmd: 'ls' } });
  });

  it('reads tool output from rawOutput field', () => {
    const events = normalizeAcpUpdate(
      {
        sessionId: 'session-1',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-raw', status: 'completed', rawOutput: { content: 'data' } },
      } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({ output: { content: 'data' } });
  });

  it('reads tool output from toolResponse field', () => {
    const events = normalizeAcpUpdate(
      {
        sessionId: 'session-1',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-resp', status: 'completed', toolResponse: 'done' },
      } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({ output: 'done' });
  });

  it('maps session_error with missing message to default', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'session_error' } } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({ type: 'session.error', message: 'Session error' });
  });

  it('maps usage_update with non-finite values', () => {
    const events = normalizeAcpUpdate(
      {
        sessionId: 'session-1',
        update: { sessionUpdate: 'usage_update', used: 'not-a-number', size: null, cost: 1.5 },
      } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({
      type: 'session.usage.updated',
      used: undefined,
      size: 0,
      cost: 1.5,
    });
  });

  it('maps usage_update token fields', () => {
    const events = normalizeAcpUpdate(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'usage_update',
          inputTokens: 123,
          outputTokens: '45',
          totalTokens: 168,
          cachedReadTokens: 10,
          cachedWriteTokens: 5,
          thoughtTokens: 'not-a-number',
        },
      } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({
      type: 'session.usage.updated',
      inputTokens: 123,
      outputTokens: 45,
      totalTokens: 168,
      cachedReadTokens: 10,
      cachedWriteTokens: 5,
      thoughtTokens: undefined,
    });
  });

  it('maps usage_update snake_case token fields', () => {
    const events = normalizeAcpUpdate(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'usage_update',
          input_tokens: 123,
          output_tokens: '45',
          total_tokens: 168,
          cached_read_tokens: 10,
          cached_write_tokens: 5,
          thought_tokens: 7,
        },
      } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({
      type: 'session.usage.updated',
      inputTokens: 123,
      outputTokens: 45,
      totalTokens: 168,
      cachedReadTokens: 10,
      cachedWriteTokens: 5,
      thoughtTokens: 7,
    });
  });

  it('maps Copilot-style context usage aliases', () => {
    const events = normalizeAcpUpdate(
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'usage_update',
          currentTokens: 1234,
          tokenLimit: 200_000,
        },
      } as never,
      ctx,
    );

    expect(events[0]).toMatchObject({
      type: 'session.usage.updated',
      used: 1234,
      size: 200_000,
    });
  });

  it('maps config_option_update with single configOption', () => {
    const option = { id: 'opt1', name: 'Option 1', type: 'boolean', value: true };
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'config_option_update', configOption: option } } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({ type: 'session.config.updated', configOptions: [option] });
  });

  it('drops config_option_update with no options', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'config_option_update' } } as never,
      ctx,
    );
    expect(events).toEqual([]);
  });

  it('drops current_mode_update with empty modeId', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'current_mode_update', currentModeId: '' } } as never,
      ctx,
    );
    expect(events).toEqual([]);
  });

  it('uses context.at when provided', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } as never,
      { ...ctx, at: 999 },
    );
    expect(events[0].at).toBe(999);
  });

  it('falls back to Date.now() when context.at is not finite', () => {
    const before = Date.now();
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } as never,
      { ...ctx, at: NaN },
    );
    expect(events[0].at).toBeGreaterThanOrEqual(before);
  });

  it('forwards locations array on tool.start', () => {
    const locations = [{ file: 'a.ts', line: 1 }];
    const events = normalizeAcpUpdate(
      {
        sessionId: 'session-1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'tool-loc', status: 'pending', locations },
      } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({ locations });
  });

  it('forwards kind field on tool.start', () => {
    const events = normalizeAcpUpdate(
      {
        sessionId: 'session-1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'tool-kind', status: 'pending', kind: 'bash' },
      } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({ kind: 'bash' });
  });

  it('maps available_commands_update with empty commands', () => {
    const events = normalizeAcpUpdate(
      { sessionId: 'session-1', update: { sessionUpdate: 'available_commands_update' } } as never,
      ctx,
    );
    expect(events[0]).toMatchObject({ type: 'session.commands.updated', commands: [] });
  });
});
