import type { WireContext, WireMiddleware } from './host.js';
import type { RuntimeObservation } from './enterprise-runtime.js';

export type RuntimeInspectorEntry =
  | { kind: 'observation'; at: number; observation: RuntimeObservation }
  | { kind: 'wire'; at: number; direction: WireContext['direction']; method?: string; id?: string | number; frame?: unknown; redacted: boolean };

export interface RuntimeInspectorOptions {
  includeWire?: boolean;
  redact?: boolean | ((frame: unknown) => unknown);
  maxEntries?: number;
}

export interface RuntimeInspector {
  observe(observation: RuntimeObservation): void;
  wireMiddleware?: WireMiddleware;
  entries(): RuntimeInspectorEntry[];
  timeline(): RuntimeInspectorEntry[];
  clear(): void;
  toJSONL(): string;
}

export function createRuntimeInspector(options: RuntimeInspectorOptions = {}): RuntimeInspector {
  const entries: RuntimeInspectorEntry[] = [];
  const maxEntries = options.maxEntries ?? 10_000;
  const redact = options.redact ?? true;

  const push = (entry: RuntimeInspectorEntry) => {
    entries.push(entry);
    if (entries.length > maxEntries) {
      entries.splice(0, entries.length - maxEntries);
    }
  };

  const inspector: RuntimeInspector = {
    observe(observation) {
      push({ kind: 'observation', at: observation.at, observation: cloneForStorage(observation) as RuntimeObservation });
    },
    entries() {
      return entries.map((entry) => cloneForStorage(entry) as RuntimeInspectorEntry);
    },
    timeline() {
      return this.entries();
    },
    clear() {
      entries.length = 0;
    },
    toJSONL() {
      return entries.map((entry) => JSON.stringify(entry)).join('\n');
    },
  };

  if (options.includeWire) {
    inspector.wireMiddleware = async (ctx, next) => {
      const frame = redactFrame(ctx.frame, redact);
      push({
        kind: 'wire',
        at: Date.now(),
        direction: ctx.direction,
        method: readJsonRpcMethod(ctx.frame),
        id: readJsonRpcId(ctx.frame),
        frame,
        redacted: Boolean(redact),
      });
      await next();
    };
  }

  return inspector;
}

function readJsonRpcMethod(frame: unknown): string | undefined {
  return frame && typeof frame === 'object' && typeof (frame as { method?: unknown }).method === 'string'
    ? (frame as { method: string }).method
    : undefined;
}

function readJsonRpcId(frame: unknown): string | number | undefined {
  if (!frame || typeof frame !== 'object') return undefined;
  const id = (frame as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

function redactFrame(frame: unknown, redact: RuntimeInspectorOptions['redact']): unknown {
  if (!redact) return cloneForStorage(frame);
  if (typeof redact === 'function') return redact(frame);
  return redactSecrets(frame);
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = /token|secret|password|api[-_]?key|authorization/i.test(key)
      ? '[redacted]'
      : redactSecrets(child);
  }
  return output;
}

function cloneForStorage(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}