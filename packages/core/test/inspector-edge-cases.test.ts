import { describe, expect, it, vi } from 'vitest';

import { createRuntimeInspector } from '../src/inspector.js';
import type { RuntimeObservation } from '../src/enterprise-runtime.js';

const baseObservation: RuntimeObservation = {
  type: 'runtime.connect.started',
  at: 1000,
  runtimeId: 'rt-1',
  agentId: 'test',
};

describe('createRuntimeInspector', () => {
  it('stores observations and retrieves them', () => {
    const inspector = createRuntimeInspector();
    inspector.observe(baseObservation);
    inspector.observe({ ...baseObservation, type: 'runtime.connect.completed', durationMs: 100 } as RuntimeObservation);
    expect(inspector.entries()).toHaveLength(2);
    expect(inspector.entries()[0].kind).toBe('observation');
  });

  it('entries() returns deep clones', () => {
    const inspector = createRuntimeInspector();
    inspector.observe(baseObservation);
    const entries = inspector.entries();
    expect(entries).toHaveLength(1);
    // Mutating the returned entry should not affect internal state
    (entries[0] as { kind: string }).kind = 'wire';
    expect(inspector.entries()[0].kind).toBe('observation');
  });

  it('timeline() is an alias for entries()', () => {
    const inspector = createRuntimeInspector();
    inspector.observe(baseObservation);
    expect(inspector.timeline()).toEqual(inspector.entries());
  });

  it('clear() removes all entries', () => {
    const inspector = createRuntimeInspector();
    inspector.observe(baseObservation);
    inspector.observe(baseObservation);
    expect(inspector.entries()).toHaveLength(2);
    inspector.clear();
    expect(inspector.entries()).toHaveLength(0);
  });

  it('toJSONL() serializes entries as newline-delimited JSON', () => {
    const inspector = createRuntimeInspector();
    inspector.observe(baseObservation);
    inspector.observe({ ...baseObservation, type: 'runtime.connect.completed', durationMs: 50 } as RuntimeObservation);
    const jsonl = inspector.toJSONL();
    const lines = jsonl.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).kind).toBe('observation');
    expect(JSON.parse(lines[1]).observation.type).toBe('runtime.connect.completed');
  });

  it('onEntry notifies listeners for each new entry', () => {
    const inspector = createRuntimeInspector();
    const seen: string[] = [];
    inspector.onEntry((entry) => {
      if (entry.kind === 'observation') seen.push(entry.observation.type);
    });
    inspector.observe(baseObservation);
    expect(seen).toEqual(['runtime.connect.started']);
  });

  it('unsubscribe stops notifications', () => {
    const inspector = createRuntimeInspector();
    const seen: string[] = [];
    const unsub = inspector.onEntry((entry) => {
      if (entry.kind === 'observation') seen.push(entry.observation.type);
    });
    inspector.observe(baseObservation);
    unsub();
    inspector.observe({ ...baseObservation, type: 'runtime.connect.completed', durationMs: 50 } as RuntimeObservation);
    expect(seen).toEqual(['runtime.connect.started']);
  });

  it('enforces maxEntries limit', () => {
    const inspector = createRuntimeInspector({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      inspector.observe({ ...baseObservation, at: i });
    }
    expect(inspector.entries()).toHaveLength(3);
    // Should retain the last 3
    expect(inspector.entries()[0]).toMatchObject({ at: expect.any(Number) });
  });
});

describe('inspector wire middleware', () => {
  it('is undefined when includeWire is not set', () => {
    const inspector = createRuntimeInspector();
    expect(inspector.wireMiddleware).toBeUndefined();
  });

  it('captures wire frames when includeWire is true', async () => {
    const inspector = createRuntimeInspector({ includeWire: true });
    expect(inspector.wireMiddleware).toBeDefined();

    const next = vi.fn();
    await inspector.wireMiddleware!({ direction: 'out', frame: { method: 'session/prompt', id: 42 } }, next);
    expect(next).toHaveBeenCalledOnce();

    const entries = inspector.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('wire');
    if (entries[0].kind === 'wire') {
      expect(entries[0].direction).toBe('out');
      expect(entries[0].method).toBe('session/prompt');
      expect(entries[0].id).toBe(42);
      expect(entries[0].redacted).toBe(true);
    }
  });

  it('redacts sensitive fields by default', async () => {
    const inspector = createRuntimeInspector({ includeWire: true });
    const next = vi.fn();
    await inspector.wireMiddleware!(
      {
        direction: 'in',
        frame: {
          method: 'auth/response',
          params: {
            token: 'secret-token-123',
            api_key: 'sk-abc',
            apiKey: 'sk-def',
            authorization: 'Bearer xyz',
            password: 'hunter2',
            secret: 'my-secret',
            normal_field: 'visible',
          },
        },
      },
      next,
    );

    const entry = inspector.entries()[0];
    if (entry.kind === 'wire') {
      const params = (entry.frame as { params: Record<string, unknown> }).params;
      expect(params.token).toBe('[redacted]');
      expect(params.api_key).toBe('[redacted]');
      expect(params.apiKey).toBe('[redacted]');
      expect(params.authorization).toBe('[redacted]');
      expect(params.password).toBe('[redacted]');
      expect(params.secret).toBe('[redacted]');
      expect(params.normal_field).toBe('visible');
    }
  });

  it('skips redaction when redact is false', async () => {
    const inspector = createRuntimeInspector({ includeWire: true, redact: false });
    const next = vi.fn();
    await inspector.wireMiddleware!(
      { direction: 'out', frame: { token: 'visible-token' } },
      next,
    );

    const entry = inspector.entries()[0];
    if (entry.kind === 'wire') {
      expect((entry.frame as { token: string }).token).toBe('visible-token');
      expect(entry.redacted).toBe(false);
    }
  });

  it('uses custom redact function', async () => {
    const customRedact = (frame: unknown) => ({ redactedBy: 'custom' });
    const inspector = createRuntimeInspector({ includeWire: true, redact: customRedact });
    const next = vi.fn();
    await inspector.wireMiddleware!(
      { direction: 'out', frame: { secret: 'data' } },
      next,
    );

    const entry = inspector.entries()[0];
    if (entry.kind === 'wire') {
      expect(entry.frame).toEqual({ redactedBy: 'custom' });
    }
  });

  it('extracts method and id from JSON-RPC frames', async () => {
    const inspector = createRuntimeInspector({ includeWire: true });
    const next = vi.fn();

    await inspector.wireMiddleware!({ direction: 'out', frame: { method: 'session/new', id: 'req-1' } }, next);
    await inspector.wireMiddleware!({ direction: 'in', frame: { id: 99, result: {} } }, next);
    await inspector.wireMiddleware!({ direction: 'out', frame: {} }, next);

    const entries = inspector.entries();
    if (entries[0].kind === 'wire') {
      expect(entries[0].method).toBe('session/new');
      expect(entries[0].id).toBe('req-1');
    }
    if (entries[1].kind === 'wire') {
      expect(entries[1].method).toBeUndefined();
      expect(entries[1].id).toBe(99);
    }
    if (entries[2].kind === 'wire') {
      expect(entries[2].method).toBeUndefined();
      expect(entries[2].id).toBeUndefined();
    }
  });

  it('redacts nested sensitive fields recursively', async () => {
    const inspector = createRuntimeInspector({ includeWire: true });
    const next = vi.fn();
    await inspector.wireMiddleware!(
      {
        direction: 'out',
        frame: {
          method: 'test',
          params: {
            nested: {
              deeply: {
                api_key: 'should-be-redacted',
                safe: 'visible',
              },
            },
            list: [{ token: 'also-redacted' }, { name: 'visible' }],
          },
        },
      },
      next,
    );

    const entry = inspector.entries()[0];
    if (entry.kind === 'wire') {
      const params = (entry.frame as { params: Record<string, unknown> }).params;
      const nested = params.nested as { deeply: Record<string, unknown> };
      expect(nested.deeply.api_key).toBe('[redacted]');
      expect(nested.deeply.safe).toBe('visible');
      const list = params.list as Array<Record<string, unknown>>;
      expect(list[0].token).toBe('[redacted]');
      expect(list[1].name).toBe('visible');
    }
  });
});
