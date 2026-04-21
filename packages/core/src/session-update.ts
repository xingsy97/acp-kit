import type { SessionUpdate } from '@agentclientprotocol/sdk';

/**
 * Map of camelCase handler keys to their ACP `sessionUpdate` discriminator literals.
 *
 * Use this when you need the literal at runtime without typing the string yourself:
 *
 * ```ts
 * if (notification.update.sessionUpdate === SessionUpdateKind.AgentMessageChunk) { ... }
 * ```
 *
 * Prefer `onSessionUpdate(...)` for the common dispatch case.
 */
export const SessionUpdateKind = {
  UserMessageChunk:        'user_message_chunk',
  AgentMessageChunk:       'agent_message_chunk',
  AgentThoughtChunk:       'agent_thought_chunk',
  ToolCall:                'tool_call',
  ToolCallUpdate:          'tool_call_update',
  Plan:                    'plan',
  AvailableCommandsUpdate: 'available_commands_update',
  CurrentModeUpdate:       'current_mode_update',
  ConfigOptionUpdate:      'config_option_update',
  SessionInfoUpdate:       'session_info_update',
  UsageUpdate:             'usage_update',
} as const satisfies Record<string, SessionUpdate['sessionUpdate']>;

/** Narrow a `SessionUpdate` to the variant whose `sessionUpdate` equals `K`. */
export type SessionUpdateOf<K extends SessionUpdate['sessionUpdate']> =
  Extract<SessionUpdate, { sessionUpdate: K }>;

type SnakeToCamel<S extends string> =
  S extends `${infer Head}_${infer Rest}`
    ? `${Head}${Capitalize<SnakeToCamel<Rest>>}`
    : S;

/**
 * Per-variant handler map for `onSessionUpdate`. All entries are optional;
 * unhandled variants fall through to the optional `default` handler (or are ignored).
 *
 * Keys are camelCase so users never have to type ACP's snake_case literals.
 *
 * ```ts
 * onSessionUpdate(notification.update, {
 *   agentMessageChunk: (u) => process.stdout.write(u.content.text ?? ''),
 *   toolCall:          (u) => console.log(`[tool] ${u.title}`),
 *   toolCallUpdate:    (u) => console.log(`[tool:${u.status}]`),
 * });
 * ```
 */
export type SessionUpdateHandlers<R = void> =
  & {
      [K in SessionUpdate['sessionUpdate'] as SnakeToCamel<K>]?: (update: SessionUpdateOf<K>) => R;
    }
  & {
      /** Invoked when no per-variant handler matched. */
      default?: (update: SessionUpdate) => R;
    };

function toCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Type-safe dispatcher for ACP `SessionUpdate` notifications.
 *
 * Replaces the manual `switch (update.sessionUpdate) { case '...': ... }` boilerplate
 * with a per-variant handler map keyed by camelCase variant names.
 *
 * Returns the handler's return value, or `undefined` if no handler matched and no
 * `default` was provided.
 */
export function onSessionUpdate<R = void>(
  update: SessionUpdate,
  handlers: SessionUpdateHandlers<R>,
): R | undefined {
  const key = toCamel(update.sessionUpdate) as keyof SessionUpdateHandlers<R>;
  const handler = handlers[key] as ((u: SessionUpdate) => R) | undefined;
  if (handler) return handler(update);
  return handlers.default?.(update);
}
