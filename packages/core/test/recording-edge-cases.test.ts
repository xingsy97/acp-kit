import { describe, expect, it, vi } from 'vitest';

import {
  createMemorySessionRecorder,
  createSessionRecording,
  loadSessionRecording,
  type RuntimeStoreEntry,
} from '../src/index.js';

describe('recording – edge cases', () => {
  it('recording with no events produces empty recording', () => {
    const recorder = createMemorySessionRecorder();
    const recording = recorder.recording();
    expect(recording.entries).toEqual([]);
    expect(recording.events).toEqual([]);
    expect(recording.observations).toEqual([]);
    expect(recording.replay.events).toEqual([]);
    expect(recording.replay.transcript.blocks).toEqual([]);
  });

  it('recording filters by sessionId', () => {
    const recorder = createMemorySessionRecorder();
    recorder.append({
      kind: 'session.event',
      at: 1,
      runtimeId: 'rt-1',
      agentId: 'test',
      sessionId: 'session-A',
      event: { type: 'message.delta', sessionId: 'session-A', at: 1, messageId: 'm1', delta: 'A' },
    });
    recorder.append({
      kind: 'session.event',
      at: 2,
      runtimeId: 'rt-1',
      agentId: 'test',
      sessionId: 'session-B',
      event: { type: 'message.delta', sessionId: 'session-B', at: 2, messageId: 'm2', delta: 'B' },
    });

    const recordingA = recorder.recording({ sessionId: 'session-A' });
    expect(recordingA.events).toHaveLength(1);
    expect(recordingA.events[0]).toMatchObject({ delta: 'A' });

    const recordingB = recorder.recording({ sessionId: 'session-B' });
    expect(recordingB.events).toHaveLength(1);
    expect(recordingB.events[0]).toMatchObject({ delta: 'B' });
  });

  it('recording filters by runtimeId', () => {
    const recorder = createMemorySessionRecorder();
    recorder.append({
      kind: 'observation',
      at: 1,
      runtimeId: 'rt-1',
      agentId: 'test',
      observation: { type: 'runtime.connect.started', at: 1, runtimeId: 'rt-1', agentId: 'test' } as never,
    });
    recorder.append({
      kind: 'observation',
      at: 2,
      runtimeId: 'rt-2',
      agentId: 'test',
      observation: { type: 'runtime.connect.started', at: 2, runtimeId: 'rt-2', agentId: 'test' } as never,
    });

    const recording = recorder.recording({ runtimeId: 'rt-1' });
    expect(recording.observations).toHaveLength(1);
  });

  it('recording filters by kind', () => {
    const recorder = createMemorySessionRecorder();
    recorder.append({
      kind: 'observation',
      at: 1,
      runtimeId: 'rt-1',
      agentId: 'test',
      observation: { type: 'runtime.connect.started', at: 1, runtimeId: 'rt-1', agentId: 'test' } as never,
    });
    recorder.append({
      kind: 'session.event',
      at: 2,
      runtimeId: 'rt-1',
      agentId: 'test',
      sessionId: 's1',
      event: { type: 'message.delta', sessionId: 's1', at: 2, messageId: 'm1', delta: 'x' },
    });

    const obsOnly = recorder.recording({ kind: 'observation' });
    expect(obsOnly.entries).toHaveLength(1);
    expect(obsOnly.entries[0].kind).toBe('observation');
  });

  it('clear() removes all entries', () => {
    const recorder = createMemorySessionRecorder();
    recorder.append({
      kind: 'observation',
      at: 1,
      runtimeId: 'rt-1',
      agentId: 'test',
      observation: { type: 'runtime.connect.started', at: 1, runtimeId: 'rt-1', agentId: 'test' } as never,
    });
    expect(recorder.entries()).toHaveLength(1);
    recorder.clear();
    expect(recorder.entries()).toHaveLength(0);
  });

  it('entries() returns deep clones', () => {
    const recorder = createMemorySessionRecorder();
    recorder.append({
      kind: 'session.event',
      at: 1,
      runtimeId: 'rt-1',
      agentId: 'test',
      sessionId: 's1',
      event: { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'original' },
    });

    const entries = recorder.entries();
    (entries[0] as RuntimeStoreEntry & { kind: 'session.event' }).event = null as never;
    const entries2 = recorder.entries();
    expect((entries2[0] as RuntimeStoreEntry & { kind: 'session.event' }).event).toBeDefined();
  });

  it('toJSONL() produces valid JSONL', () => {
    const recorder = createMemorySessionRecorder();
    recorder.append({
      kind: 'session.event',
      at: 1,
      runtimeId: 'rt-1',
      agentId: 'test',
      sessionId: 's1',
      event: { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'a' },
    });
    recorder.append({
      kind: 'session.event',
      at: 2,
      runtimeId: 'rt-1',
      agentId: 'test',
      sessionId: 's1',
      event: { type: 'message.delta', sessionId: 's1', at: 2, messageId: 'm1', delta: 'b' },
    });

    const recording = recorder.recording();
    const jsonl = recording.toJSONL();
    const lines = jsonl.split('\n');
    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(() => JSON.parse(lines[1])).not.toThrow();
  });

  it('replay reconstructs transcript from events', () => {
    const recorder = createMemorySessionRecorder();
    recorder.append({
      kind: 'session.event',
      at: 1,
      runtimeId: 'rt-1',
      agentId: 'test',
      sessionId: 's1',
      event: { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'hel' },
    });
    recorder.append({
      kind: 'session.event',
      at: 2,
      runtimeId: 'rt-1',
      agentId: 'test',
      sessionId: 's1',
      event: { type: 'message.delta', sessionId: 's1', at: 2, messageId: 'm1', delta: 'lo' },
    });
    recorder.append({
      kind: 'session.event',
      at: 3,
      runtimeId: 'rt-1',
      agentId: 'test',
      sessionId: 's1',
      event: { type: 'message.completed', sessionId: 's1', at: 3, messageId: 'm1', content: 'hello' },
    });

    const recording = recorder.recording();
    expect(recording.replay.transcript.blocks).toEqual([
      expect.objectContaining({ kind: 'message', content: 'hello', completed: true }),
    ]);
  });

  it('createSessionRecording works from iterable entries', () => {
    const entries: RuntimeStoreEntry[] = [
      {
        kind: 'session.event',
        at: 1,
        runtimeId: 'rt-1',
        agentId: 'test',
        sessionId: 's1',
        event: { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'direct' },
      },
    ];
    const recording = createSessionRecording(entries);
    expect(recording.events).toHaveLength(1);
    expect(recording.replay.transcript.blocks[0].content).toBe('direct');
  });

  it('loadSessionRecording throws when store lacks load()', async () => {
    const store = { append: vi.fn() };
    await expect(loadSessionRecording(store)).rejects.toThrow(/load/);
  });

  it('loadSessionRecording works with async store.load()', async () => {
    const store = {
      append: vi.fn(),
      load: vi.fn().mockResolvedValue([
        {
          kind: 'session.event',
          at: 1,
          runtimeId: 'rt-1',
          agentId: 'test',
          sessionId: 's1',
          event: { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'loaded' },
        },
      ]),
    };
    const recording = await loadSessionRecording(store, { sessionId: 's1' });
    expect(recording.events).toHaveLength(1);
    expect(recording.replay.transcript.blocks[0].content).toBe('loaded');
  });
});
