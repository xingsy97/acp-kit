import type { RuntimeSessionEvent } from './session.js';
import type { RuntimeEventStore, RuntimeEventStoreQuery, RuntimeObservation, RuntimeStoreEntry } from './enterprise-runtime.js';
import { createRuntimeReplay, type RuntimeReplay } from './enterprise-runtime.js';

export interface RuntimeSessionRecording {
  entries: RuntimeStoreEntry[];
  observations: RuntimeObservation[];
  events: RuntimeSessionEvent[];
  replay: RuntimeReplay;
  toJSONL(): string;
}

export interface MemorySessionRecorder extends RuntimeEventStore {
  entries(): RuntimeStoreEntry[];
  recording(query?: RuntimeEventStoreQuery): RuntimeSessionRecording;
  clear(): void;
}

export function createMemorySessionRecorder(): MemorySessionRecorder {
  const entries: RuntimeStoreEntry[] = [];
  const recorder: MemorySessionRecorder = {
    append(entry) {
      entries.push(cloneEntry(entry));
    },
    async load(query = {}) {
      return filterEntries(entries, query).map(cloneEntry);
    },
    entries() {
      return entries.map(cloneEntry);
    },
    recording(query = {}) {
      return createSessionRecording(filterEntries(entries, query));
    },
    clear() {
      entries.length = 0;
    },
  };
  return recorder;
}

export function createSessionRecording(entries: Iterable<RuntimeStoreEntry>): RuntimeSessionRecording {
  const materialized = [...entries].map(cloneEntry);
  const events = materialized
    .filter((entry): entry is Extract<RuntimeStoreEntry, { kind: 'session.event' }> => entry.kind === 'session.event')
    .map((entry) => entry.event);
  const observations = materialized
    .filter((entry): entry is Extract<RuntimeStoreEntry, { kind: 'observation' }> => entry.kind === 'observation')
    .map((entry) => entry.observation);
  return {
    entries: materialized,
    observations,
    events,
    replay: createRuntimeReplay(events),
    toJSONL() {
      return materialized.map((entry) => JSON.stringify(entry)).join('\n');
    },
  };
}

export async function loadSessionRecording(
  store: RuntimeEventStore,
  query: RuntimeEventStoreQuery = {},
): Promise<RuntimeSessionRecording> {
  if (!store.load) {
    throw new Error('RuntimeEventStore does not implement load().');
  }
  return createSessionRecording(await store.load(query));
}

function filterEntries(entries: RuntimeStoreEntry[], query: RuntimeEventStoreQuery): RuntimeStoreEntry[] {
  return entries.filter((entry) => {
    if (query.runtimeId && entry.runtimeId !== query.runtimeId) return false;
    if (query.kind && entry.kind !== query.kind) return false;
    if (query.sessionId) {
      if (!('sessionId' in entry) || entry.sessionId !== query.sessionId) return false;
    }
    return true;
  });
}

function cloneEntry<T extends RuntimeStoreEntry>(entry: T): T {
  return JSON.parse(JSON.stringify(entry)) as T;
}