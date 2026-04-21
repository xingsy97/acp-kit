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
 * Prefer `onRuntimeEvent(...)` for the common dispatch case.
 */
export const RuntimeEventKind = {
  MessageDelta:           'message.delta',
  MessageCompleted:       'message.completed',
  ReasoningDelta:         'reasoning.delta',
  ReasoningCompleted:     'reasoning.completed',
  ToolStart:              'tool.start',
  ToolUpdate:             'tool.update',
  ToolEnd:                'tool.end',
  SessionCommandsUpdated: 'session.commands.updated',
  SessionConfigUpdated:   'session.config.updated',
  SessionModesUpdated:    'session.modes.updated',
  SessionModeUpdated:     'session.mode.updated',
  SessionModelsUpdated:   'session.models.updated',
  SessionModelUpdated:    'session.model.updated',
  SessionUsageUpdated:    'session.usage.updated',
} as const satisfies Record<string, RuntimeEvent['type']>;

/** Narrow a `RuntimeEvent` to the variant whose `type` equals `K`. */
export type RuntimeEventOf<K extends RuntimeEvent['type']> =
  Extract<RuntimeEvent, { type: K }>;

type DotToCamel<S extends string> =
  S extends `${infer Head}.${infer Rest}`
    ? `${Head}${Capitalize<DotToCamel<Rest>>}`
    : S;

/**
 * Per-variant handler map for `onRuntimeEvent`. All entries are optional;
 * unhandled variants fall through to the optional `default` handler (or are ignored).
 *
 * Keys are camelCase, derived from the `dot.case` event types (`message.delta` →
 * `messageDelta`, `session.commands.updated` → `sessionCommandsUpdated`).
 *
 * ```ts
 * onRuntimeEvent(event, {
 *   messageDelta:  (e) => process.stdout.write(e.delta),
 *   toolStart:     (e) => console.log(`[${e.toolCallId}] ${e.title ?? e.name}`),
 *   toolEnd:       (e) => console.log(`[${e.toolCallId}] ${e.status}`),
 * });
 * ```
 */
export type RuntimeEventHandlers<R = void> =
  & {
      [K in RuntimeEvent['type'] as DotToCamel<K>]?: (event: RuntimeEventOf<K>) => R;
    }
  & {
      /** Invoked when no per-variant handler matched. */
      default?: (event: RuntimeEvent) => R;
    };

function toCamel(dotted: string): string {
  return dotted.replace(/\.([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Type-safe dispatcher for **normalized** `RuntimeEvent`s emitted by `RuntimeSession`.
 *
 * "Normalized" means: ACP `session/update` traffic has been aggregated into stable
 * per-message / per-tool / per-turn events with stable ids (`messageId`, `reasoningId`,
 * `toolCallId`). For the lower-level raw ACP surface use `onRawSessionUpdate`.
 *
 * Replaces manual `switch (event.type) { case 'message.delta': ... }` with a
 * camelCase handler map.
 *
 * Returns the handler's return value, or `undefined` if no handler matched and no
 * `default` was provided.
 */
export function onRuntimeEvent<R = void>(
  event: RuntimeEvent,
  handlers: RuntimeEventHandlers<R>,
): R | undefined {
  const key = toCamel(event.type) as keyof RuntimeEventHandlers<R>;
  const handler = handlers[key] as ((e: RuntimeEvent) => R) | undefined;
  if (handler) return handler(event);
  return handlers.default?.(event);
}
