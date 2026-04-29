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

  it('reads nested reasoning text from array content blocks', () => {
    const sessionId = 'session-reasoning-blocks';
    const events = normalizeAcpUpdate(
      {
        sessionId,
        update: {
          sessionUpdate: 'thinking_chunk',
          content: [
            { type: 'thinking', thinking: 'first ' },
            { type: 'reasoning', reasoning: [{ type: 'text', text: 'second' }] },
          ],
        },
      } as never,
      { sessionId, turnId: 'turn-1', reasoningId: 'reason-1' },
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: 'reasoning.delta',
        reasoningId: 'reason-1',
        delta: 'first second',
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

  it('maps plan updates with full entry list', () => {
    const sessionId = 'session-plan';
    const entries = [
      { content: 'Read repo layout', status: 'completed', priority: 'high' },
      { content: 'Add normalize case for plan', status: 'in_progress', priority: 'high' },
      { content: 'Update transcript', status: 'pending', priority: 'medium' },
    ];
    const events = normalizeAcpUpdate(
      {
        sessionId,
        update: { sessionUpdate: 'plan', entries },
      } as never,
      { sessionId, turnId: 'turn-1' },
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: 'session.plan.updated',
        sessionId,
        turnId: 'turn-1',
        entries,
      }),
    ]);
  });

  it('emits an empty entries array when plan has no entries', () => {
    const sessionId = 'session-plan-empty';
    const events = normalizeAcpUpdate(
      {
        sessionId,
        update: { sessionUpdate: 'plan' },
      } as never,
      { sessionId },
    );

    expect(events).toEqual([
      expect.objectContaining({ type: 'session.plan.updated', entries: [] }),
    ]);
  });

  it('forwards locations and structured content on tool events', () => {
    const sessionId = 'session-tool-content';
    const locations = [{ path: '/repo/src/index.ts', line: 12 }];
    const content = [
      { type: 'content', content: { type: 'text', text: 'patched index.ts' } },
      {
        type: 'diff',
        path: '/repo/src/index.ts',
        oldText: 'foo\n',
        newText: 'bar\n',
      },
    ];
    const started = normalizeAcpUpdate(
      {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-rich',
          toolName: 'edit_file',
          status: 'in_progress',
          locations,
          content,
        },
      } as never,
      { sessionId },
    );
    const ended = normalizeAcpUpdate(
      {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-rich',
          status: 'completed',
          locations,
          content,
        },
      } as never,
      { sessionId },
    );

    expect(started[0]).toMatchObject({
      type: 'tool.start',
      toolCallId: 'tool-rich',
      locations,
      content,
    });
    expect(ended[0]).toMatchObject({
      type: 'tool.end',
      status: 'completed',
      locations,
      content,
    });
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

  it('stores currentPlan on session metadata and replaces it wholesale', () => {
    const state = createTranscriptState();

    applyRuntimeEvents(state, [
      {
        type: 'session.plan.updated',
        sessionId: 'session-1',
        at: 1,
        turnId: 'turn-1',
        entries: [
          { content: 'Step A', status: 'completed', priority: 'high' },
          { content: 'Step B', status: 'in_progress', priority: 'medium' },
        ],
      },
    ]);
    expect(state.session.currentPlan?.entries).toHaveLength(2);

    // Subsequent plan update wins outright.
    applyRuntimeEvents(state, [
      {
        type: 'session.plan.updated',
        sessionId: 'session-1',
        at: 2,
        turnId: 'turn-1',
        entries: [
          { content: 'Step A', status: 'completed', priority: 'high' },
          { content: 'Step B', status: 'completed', priority: 'medium' },
          { content: 'Step C', status: 'pending', priority: 'low' },
        ],
      },
    ]);
    expect(state.session.currentPlan?.entries).toHaveLength(3);
    expect(state.session.currentPlan?.entries[1].status).toBe('completed');
  });

  it('carries tool locations and structured content into the transcript record', () => {
    const state = createTranscriptState();
    const locations = [{ path: '/repo/src/index.ts', line: 1 }];
    const content = [{ type: 'diff', path: '/repo/src/index.ts', oldText: 'a', newText: 'b' }];

    applyRuntimeEvents(state, [
      {
        type: 'tool.start',
        sessionId: 's',
        at: 1,
        turnId: 't',
        toolCallId: 'tc',
        name: 'edit_file',
        status: 'running',
        locations,
        content,
      } as never,
      {
        type: 'tool.update',
        sessionId: 's',
        at: 2,
        turnId: 't',
        toolCallId: 'tc',
        status: 'running',
        // Empty update without content/locations must not erase the prior fields.
      } as never,
    ]);

    expect(state.tools.tc).toMatchObject({
      locations,
      content,
      status: 'running',
    });
  });
});
