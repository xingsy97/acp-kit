import type { RuntimeEvent } from './events.js';

/**
 * Map of camelCase handler keys to their `RuntimeEvent.type` literal strings.
 *
 * Use this when you need the literal at runtime without typing the string yourself:
 *
 * ```ts
 * if (event.type === RuntimeEventKind.ToolStart) { ... }
 * ```
 *
 * Prefer `onRuntimeEvent(...)` (or `session.on({ ... })`) for the common dispatch case.
 */
export const RuntimeEventKind = {
  MessageDelta:           'message.delta',
  MessageCompleted:       'message.completed',
  ReasoningDelta:         'reasoning.delta',
  ReasoningCompleted:     'reasoning.completed',
  ToolStart:              'tool.start',
  ToolUpdate:             'tool.update',
  ToolEnd:                'tool.end',
  TurnStarted:            'turn.started',
  TurnCompleted:          'turn.completed',
  TurnFailed:             'turn.failed',
  TurnCancelled:          'turn.cancelled',
  StatusChanged:          'status.changed',
  SessionCommandsUpdated: 'session.commands.updated',
  SessionConfigUpdated:   'session.config.updated',
  SessionModesUpdated:    'session.modes.updated',
  SessionModeUpdated:     'session.mode.updated',
  SessionModelsUpdated:   'session.models.updated',
  SessionModelUpdated:    'session.model.updated',
  SessionUsageUpdated:    'session.usage.updated',
  SessionPlanUpdated:     'session.plan.updated',
  SessionError:           'session.error',
} as const;

type DotToCamel<S extends string> =
  S extends `${infer Head}.${infer Rest}`
    ? `${Head}${Capitalize<DotToCamel<Rest>>}`
    : S;

/**
 * Per-variant handler map for `onRuntimeEvent` and `session.on(handlers)`.
 *
 * Generic over the event union so the same helper can dispatch the data-only
 * `RuntimeEvent` set or the full `RuntimeSessionEvent` set (which adds turn /
 * status events). Keys are camelCase, derived from the `dot.case` event types
 * (`message.delta` → `messageDelta`, `session.commands.updated` →
 * `sessionCommandsUpdated`).
 *
 * All entries are optional; unhandled variants fall through to the optional
 * `default` handler (or are ignored).
 *
 * ```ts
 * session.on({
 *   messageDelta:  (e) => process.stdout.write(e.delta),
 *   toolStart:     (e) => process.stdout.write(`[${e.toolCallId}] ${e.title ?? e.name}\n`),
 *   turnCompleted: (e) => process.stdout.write(`done: ${e.stopReason}\n`),
 * });
 * ```
 */
export type RuntimeEventHandlers<E extends { type: string } = RuntimeEvent, R = void> =
  & {
      [K in E['type'] as DotToCamel<K>]?: (event: Extract<E, { type: K }>) => R;
    }
  & {
      /** Invoked when no per-variant handler matched. */
      default?: (event: E) => R;
    };

function toCamel(dotted: string): string {
  return dotted.replace(/\.([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Type-safe dispatcher for normalized events emitted by `RuntimeSession`.
 *
 * Replaces manual `switch (event.type) { case 'message.delta': ... }` with a
 * camelCase handler map.
 *
 * Returns the handler's return value, or `undefined` if no handler matched and no
 * `default` was provided.
 */
export function onRuntimeEvent<E extends { type: string }, R = void>(
  event: E,
  handlers: RuntimeEventHandlers<E, R>,
): R | undefined {
  const key = toCamel(event.type) as keyof RuntimeEventHandlers<E, R>;
  const handler = handlers[key] as ((e: E) => R) | undefined;
  if (handler) return handler(event);
  const fallback = (handlers as { default?: (e: E) => R }).default;
  return fallback?.(event);
}
