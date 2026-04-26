import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RuntimeEventStore, RuntimeEventStoreQuery, RuntimeStoreEntry } from './enterprise-runtime.js';
import { createSessionRecording, type RuntimeSessionRecording } from './recording.js';

export interface FileSessionRecorderOptions {
  dir: string;
  recordingName?: string;
}

export interface FileSessionRecorder extends RuntimeEventStore {
  readonly recordingPath: string;
  loadRecording(query?: RuntimeEventStoreQuery): RuntimeSessionRecording;
}

export function createFileSessionRecorder(options: FileSessionRecorderOptions): FileSessionRecorder {
  const recordingPath = join(options.dir, options.recordingName || timestampName());
  const entriesPath = join(recordingPath, 'entries.jsonl');
  const eventsPath = join(recordingPath, 'events.jsonl');
  const observationsPath = join(recordingPath, 'observations.jsonl');
  mkdirSync(recordingPath, { recursive: true });
  writeFileSync(join(recordingPath, 'metadata.json'), `${JSON.stringify({
    format: 'acp-kit.session-recording.v1',
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`);

  return {
    recordingPath,
    append(entry) {
      const line = `${JSON.stringify(entry)}\n`;
      appendFileSync(entriesPath, line);
      if (entry.kind === 'session.event') appendFileSync(eventsPath, line);
      if (entry.kind === 'observation') appendFileSync(observationsPath, line);
    },
    async load(query = {}) {
      return loadEntries(entriesPath, query);
    },
    loadRecording(query = {}) {
      return createSessionRecording(loadEntries(entriesPath, query));
    },
  };
}

export function loadFileSessionRecording(recordingPath: string, query: RuntimeEventStoreQuery = {}): RuntimeSessionRecording {
  return createSessionRecording(loadEntries(join(recordingPath, 'entries.jsonl'), query));
}

function loadEntries(filePath: string, query: RuntimeEventStoreQuery): RuntimeStoreEntry[] {
  const text = readFileSync(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeStoreEntry)
    .filter((entry) => {
      if (query.runtimeId && entry.runtimeId !== query.runtimeId) return false;
      if (query.kind && entry.kind !== query.kind) return false;
      if (query.sessionId && (!('sessionId' in entry) || entry.sessionId !== query.sessionId)) return false;
      return true;
    });
}

function timestampName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}