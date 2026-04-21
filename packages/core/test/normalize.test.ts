import { describe, expect, it } from 'vitest';

import {
  applyRuntimeEvents,
  createTranscriptState,
  flushOpenStreamCompletions,
  normalizeAcpUpdate,
} from '../src/index.js';

describe('normalizeAcpUpdate', () => {
  it('maps streaming text and reasoning updates into runtime events', () => {
    const sessionId = 'session-1';
    const messageEvents = normalizeAcpUpdate(
      {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      } as never,
      {
        sessionId,
        turnId: 'turn-1',
        messageId: 'message-1',
      },
    );

    const reasoningEvents = normalizeAcpUpdate(
      {
        sessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'thinking' },
        },
      } as never,
      {
        sessionId,
        turnId: 'turn-1',
        reasoningId: 'reason-1',
      },
    );

    expect(messageEvents).toEqual([
      expect.objectContaining({
        type: 'message.delta',
        messageId: 'message-1',
        delta: 'hello',
      }),
    ]);
    expect(reasoningEvents).toEqual([
      expect.objectContaining({
        type: 'reasoning.delta',
        reasoningId: 'reason-1',
        delta: 'thinking',
      }),
    ]);
  });

  it('maps tool lifecycle updates', () => {
    const sessionId = 'session-2';
    const started = normalizeAcpUpdate(
      {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          toolName: 'read_file',
          status: 'pending',
          input: { path: 'README.md' },
        },
      } as never,
      { sessionId },
    );
    const ended = normalizeAcpUpdate(
      {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status: 'completed',
          rawOutput: { content: 'done' },
        },
      } as never,
      { sessionId },
    );

    expect(started).toEqual([
      expect.objectContaining({
        type: 'tool.start',
        toolCallId: 'tool-1',
        name: 'read_file',
      }),
    ]);
    expect(ended).toEqual([
      expect.objectContaining({
        type: 'tool.end',
        toolCallId: 'tool-1',
        status: 'completed',
      }),
    ]);
  });

  it('forwards _meta verbatim on tool events', () => {
    const sessionId = 'session-meta';
    const meta = { claudeCode: { toolName: 'Bash', input: { cmd: 'ls' } }, custom: 42 };
    const started = normalizeAcpUpdate(
      {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-m',
          status: 'pending',
          _meta: meta,
        },
      } as never,
      { sessionId },
    );
    const ended = normalizeAcpUpdate(
      {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-m',
          status: 'completed',
          _meta: meta,
        },
      } as never,
      { sessionId },
    );

    expect(started[0]).toMatchObject({ type: 'tool.start', meta });
    expect(ended[0]).toMatchObject({ type: 'tool.end', meta });
  });

  it('maps session_error to session.error', () => {
    const sessionId = 'session-e';
    const events = normalizeAcpUpdate(
      {
        sessionId,
        update: {
          sessionUpdate: 'session_error',
          message: 'MCP server disconnected',
        },
      } as never,
      { sessionId },
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: 'session.error',
        sessionId,
        message: 'MCP server disconnected',
      }),
    ]);
  });
});

describe('transcript reducer', () => {
  it('reduces deltas and flushes pending stream completions', () => {
    const state = createTranscriptState();

    applyRuntimeEvents(state, [
      {
        type: 'message.delta',
        sessionId: 'session-1',
        at: 1,
        turnId: 'turn-1',
        messageId: 'message-1',
        delta: 'hello',
      },
      {
        type: 'reasoning.delta',
        sessionId: 'session-1',
        at: 2,
        turnId: 'turn-1',
        reasoningId: 'reason-1',
        delta: 'thinking',
      },
    ]);

    const completions = flushOpenStreamCompletions(state, 3);

    expect(completions).toEqual([
      expect.objectContaining({ type: 'message.completed', content: 'hello' }),
      expect.objectContaining({ type: 'reasoning.completed', content: 'thinking' }),
    ]);
    expect(state.blocks.every((block) => block.completed)).toBe(true);
  });
});
