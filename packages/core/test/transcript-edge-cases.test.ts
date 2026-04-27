import { describe, expect, it } from 'vitest';

import {
  applyRuntimeEvent,
  applyRuntimeEvents,
  createTranscriptState,
  cloneTranscriptState,
  flushOpenStreamCompletions,
} from '../src/index.js';
import type { RuntimeEvent } from '../src/events.js';

describe('transcript reducer – edge cases', () => {
  it('accumulates multiple deltas for the same message', () => {
    const state = createTranscriptState();
    applyRuntimeEvents(state, [
      { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'hel' },
      { type: 'message.delta', sessionId: 's1', at: 2, messageId: 'm1', delta: 'lo' },
      { type: 'message.delta', sessionId: 's1', at: 3, messageId: 'm1', delta: ' world' },
    ]);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0].content).toBe('hello world');
    expect(state.blocks[0].completed).toBe(false);
  });

  it('message.completed overwrites accumulated delta content', () => {
    const state = createTranscriptState();
    applyRuntimeEvents(state, [
      { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'partial' },
      { type: 'message.completed', sessionId: 's1', at: 2, messageId: 'm1', content: 'final content' },
    ]);
    expect(state.blocks[0].content).toBe('final content');
    expect(state.blocks[0].completed).toBe(true);
  });

  it('tracks separate blocks for message and reasoning with same turn', () => {
    const state = createTranscriptState();
    applyRuntimeEvents(state, [
      { type: 'reasoning.delta', sessionId: 's1', at: 1, turnId: 't1', reasoningId: 'r1', delta: 'thinking' },
      { type: 'message.delta', sessionId: 's1', at: 2, turnId: 't1', messageId: 'm1', delta: 'answer' },
    ]);
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]).toMatchObject({ kind: 'reasoning', content: 'thinking' });
    expect(state.blocks[1]).toMatchObject({ kind: 'message', content: 'answer' });
  });

  it('tool.start creates a tool record', () => {
    const state = createTranscriptState();
    applyRuntimeEvent(state, {
      type: 'tool.start',
      sessionId: 's1',
      at: 1,
      toolCallId: 't1',
      name: 'read_file',
      title: 'Read file',
      status: 'running',
      input: { path: '/a.ts' },
    } as RuntimeEvent);
    expect(state.tools['t1']).toMatchObject({
      toolCallId: 't1',
      name: 'read_file',
      title: 'Read file',
      status: 'running',
      input: { path: '/a.ts' },
    });
  });

  it('tool.update preserves existing fields and updates status', () => {
    const state = createTranscriptState();
    applyRuntimeEvent(state, {
      type: 'tool.start',
      sessionId: 's1',
      at: 1,
      toolCallId: 't1',
      name: 'bash',
      title: 'Run command',
      status: 'running',
      input: { cmd: 'ls' },
    } as RuntimeEvent);
    applyRuntimeEvent(state, {
      type: 'tool.update',
      sessionId: 's1',
      at: 2,
      toolCallId: 't1',
      status: 'running',
      output: { partial: true },
    } as RuntimeEvent);
    expect(state.tools['t1'].name).toBe('bash');
    expect(state.tools['t1'].title).toBe('Run command');
    expect(state.tools['t1'].output).toEqual({ partial: true });
  });

  it('tool.end on unknown toolCallId creates a new record', () => {
    const state = createTranscriptState();
    applyRuntimeEvent(state, {
      type: 'tool.end',
      sessionId: 's1',
      at: 1,
      toolCallId: 'unknown-tool',
      status: 'completed',
      output: 'done',
    } as RuntimeEvent);
    expect(state.tools['unknown-tool']).toMatchObject({
      toolCallId: 'unknown-tool',
      name: 'tool',
      status: 'completed',
    });
  });

  it('session metadata events update state correctly', () => {
    const state = createTranscriptState();
    applyRuntimeEvent(state, {
      type: 'session.commands.updated',
      sessionId: 's1',
      at: 1,
      commands: [{ id: 'cmd1', name: 'Cmd 1' }] as never,
    });
    expect(state.session.commands).toHaveLength(1);

    applyRuntimeEvent(state, {
      type: 'session.config.updated',
      sessionId: 's1',
      at: 2,
      configOptions: [{ id: 'opt1', name: 'Opt', type: 'boolean', value: true }] as never,
    });
    expect(state.session.configOptions).toHaveLength(1);

    applyRuntimeEvent(state, {
      type: 'session.modes.updated',
      sessionId: 's1',
      at: 3,
      state: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] },
    } as RuntimeEvent);
    expect(state.session.currentModeId).toBe('code');
    expect(state.session.modes?.currentModeId).toBe('code');

    applyRuntimeEvent(state, {
      type: 'session.mode.updated',
      sessionId: 's1',
      at: 4,
      currentModeId: 'plan',
    } as RuntimeEvent);
    expect(state.session.currentModeId).toBe('plan');
    expect(state.session.modes?.currentModeId).toBe('plan');
  });

  it('session.model.updated updates both currentModelId and modes state', () => {
    const state = createTranscriptState();
    applyRuntimeEvent(state, {
      type: 'session.models.updated',
      sessionId: 's1',
      at: 1,
      state: { currentModelId: 'gpt-5', availableModels: [{ modelId: 'gpt-5', name: 'GPT-5' }] },
    } as RuntimeEvent);
    expect(state.session.currentModelId).toBe('gpt-5');

    applyRuntimeEvent(state, {
      type: 'session.model.updated',
      sessionId: 's1',
      at: 2,
      currentModelId: 'gpt-6',
    } as RuntimeEvent);
    expect(state.session.currentModelId).toBe('gpt-6');
    expect(state.session.models?.currentModelId).toBe('gpt-6');
  });

  it('usage_update merges incrementally', () => {
    const state = createTranscriptState();
    applyRuntimeEvent(state, {
      type: 'session.usage.updated',
      sessionId: 's1',
      at: 1,
      used: 100,
      size: 1000,
    } as RuntimeEvent);
    expect(state.session.usage).toEqual({ used: 100, size: 1000 });

    applyRuntimeEvent(state, {
      type: 'session.usage.updated',
      sessionId: 's1',
      at: 2,
      cost: 0.05,
    } as RuntimeEvent);
    expect(state.session.usage).toEqual({ used: 100, size: 1000, cost: 0.05 });
  });

  it('flushOpenStreamCompletions skips already completed blocks', () => {
    const state = createTranscriptState();
    applyRuntimeEvents(state, [
      { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'done' },
      { type: 'message.completed', sessionId: 's1', at: 2, messageId: 'm1', content: 'done' },
      { type: 'message.delta', sessionId: 's1', at: 3, messageId: 'm2', delta: 'pending' },
    ]);
    const completions = flushOpenStreamCompletions(state, 10);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ type: 'message.completed', messageId: 'm2', content: 'pending' });
  });

  it('flushOpenStreamCompletions returns empty array when all blocks are complete', () => {
    const state = createTranscriptState();
    applyRuntimeEvents(state, [
      { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'x' },
      { type: 'message.completed', sessionId: 's1', at: 2, messageId: 'm1', content: 'x' },
    ]);
    const completions = flushOpenStreamCompletions(state, 10);
    expect(completions).toEqual([]);
  });

  it('cloneTranscriptState produces a deep independent copy', () => {
    const state = createTranscriptState();
    applyRuntimeEvents(state, [
      { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'hello' },
    ]);
    applyRuntimeEvent(state, {
      type: 'tool.start',
      sessionId: 's1',
      at: 2,
      toolCallId: 't1',
      name: 'bash',
      status: 'running',
    } as RuntimeEvent);

    const clone = cloneTranscriptState(state);
    clone.blocks[0].content = 'mutated';
    clone.tools['t1'].name = 'mutated';

    expect(state.blocks[0].content).toBe('hello');
    expect(state.tools['t1'].name).toBe('bash');
  });

  it('handles empty state clone', () => {
    const state = createTranscriptState();
    const clone = cloneTranscriptState(state);
    expect(clone.blocks).toEqual([]);
    expect(clone.tools).toEqual({});
    expect(clone.session.commands).toEqual([]);
  });

  it('multiple reasoning blocks across different turns', () => {
    const state = createTranscriptState();
    applyRuntimeEvents(state, [
      { type: 'reasoning.delta', sessionId: 's1', at: 1, turnId: 't1', reasoningId: 'r1', delta: 'think 1' },
      { type: 'reasoning.delta', sessionId: 's1', at: 2, turnId: 't2', reasoningId: 'r2', delta: 'think 2' },
    ]);
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0].turnId).toBe('t1');
    expect(state.blocks[1].turnId).toBe('t2');
  });
});
