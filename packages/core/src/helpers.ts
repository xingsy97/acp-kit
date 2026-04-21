import type { McpServer, SessionNotification } from '@agentclientprotocol/sdk';

import type { RuntimeHost } from './host.js';
import type { AgentProfile, BuiltInProfileId } from './profiles.js';
import { createAcpRuntime, type AcpTransport } from './runtime.js';
import type { RuntimeSessionEvent } from './session.js';
import type { AcpConnectionFactory, SpawnProcess } from './transports/node.js';

export interface RunPromptOptions {
  profile: AgentProfile | BuiltInProfileId;
  cwd: string;
  prompt: string;
  /**
   * Optional host implementation. Defaults to a host that auto-allows tool permissions and uses the
   * first available auth method. Provide your own for production use.
   */
  host?: RuntimeHost;
  mcpServers?: McpServer[];
  /** Pluggable transport. Defaults to the node child-process transport. */
  transport?: AcpTransport;
}

/**
 * One-shot helper at the **normalized** event layer: spawn the agent, run a single prompt,
 * yield each `RuntimeSessionEvent` (`message.delta`, `tool.start`, `turn.completed`, ...),
 * and dispose every resource on completion.
 *
 * The agent process is killed when iteration completes (normally or via early `break`/`return`)
 * or when the underlying turn fails or is cancelled.
 *
 * For multi-turn, multi-session, or long-lived hosts use `createAcpRuntime` directly.
 *
 * ```ts
 * for await (const event of runPrompt({ profile: 'copilot', cwd, prompt: 'Hi' })) {
 *   if (event.type === 'message.delta') process.stdout.write(event.delta);
 * }
 * ```
 */
export function runPrompt(options: RunPromptOptions): AsyncIterableIterator<RuntimeSessionEvent> {
  const host: RuntimeHost = options.host ?? {
    requestPermission: async () => 'allow_once',
    chooseAuthMethod: async ({ methods }) => methods[0]?.id ?? null,
  };

  const runtime = createAcpRuntime({
    profile: options.profile,
    host,
    transport: options.transport,
  });

  let closed = false;
  const queue: RuntimeSessionEvent[] = [];
  const waiters: Array<(result: IteratorResult<RuntimeSessionEvent>) => void> = [];
  let error: unknown = null;
  let done = false;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    try {
      await runtime.shutdown();
    } catch {
      /* swallow shutdown errors during cleanup */
    }
  };

  const finish = async (err?: unknown) => {
    if (err && !error) error = err;
    done = true;
    await cleanup();
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (error) waiter({ value: undefined as never, done: true });
      else waiter({ value: undefined as never, done: true });
    }
  };

  const init = (async () => {
    const session = await runtime.newSession({ cwd: options.cwd, mcpServers: options.mcpServers });
    session.on('event', (event) => {
      if (waiters.length > 0) {
        waiters.shift()!({ value: event, done: false });
      } else {
        queue.push(event);
      }
    });
    const handle = session.prompt(options.prompt);
    handle.then(() => finish(), (err) => finish(err));
  })().catch((err) => finish(err));

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<RuntimeSessionEvent>> {
      await init;
      if (queue.length > 0) {
        return { value: queue.shift()!, done: false };
      }
      if (done) {
        if (error) throw error;
        return { value: undefined as never, done: true };
      }
      return new Promise((resolve, reject) => {
        waiters.push((result) => {
          if (error) reject(error);
          else resolve(result);
        });
      });
    },
    async return(): Promise<IteratorResult<RuntimeSessionEvent>> {
      await cleanup();
      return { value: undefined as never, done: true };
    },
  };
}

export interface RunOneShotPromptOptions {
  profile: AgentProfile | BuiltInProfileId;
  cwd: string;
  prompt: string;
  /**
   * Optional host implementation. Defaults to a host that auto-allows tool permissions and uses the
   * first available auth method. Provide your own for production use.
   */
  host?: RuntimeHost;
  mcpServers?: McpServer[];
  /** Pluggable transport. Defaults to the node child-process transport. */
  transport?: AcpTransport;
  /** @deprecated Use `transport` instead. */
  spawnProcess?: SpawnProcess;
  /** @deprecated Use `transport` instead. */
  connectionFactory?: AcpConnectionFactory;
}

/**
 * Raw-layer one-shot helper. Yields raw ACP `session/update` notifications.
 *
 * For most consumers prefer the normalized {@link runPrompt} helper. Use this only when you need
 * the protocol-faithful payload (e.g. building a protocol bridge or a debugger).
 */
export function runOneShotPrompt(options: RunOneShotPromptOptions): AsyncIterableIterator<SessionNotification> {
  const host: RuntimeHost = options.host ?? {
    requestPermission: async () => 'allow_once',
    chooseAuthMethod: async ({ methods }) => methods[0]?.id ?? null,
  };

  const runtime = createAcpRuntime({
    profile: options.profile,
    host,
    transport: options.transport,
    spawnProcess: options.spawnProcess,
    connectionFactory: options.connectionFactory,
  });

  let closed = false;
  let underlying: AsyncIterator<SessionNotification> | null = null;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    try {
      await runtime.shutdown();
    } catch {
      /* swallow shutdown errors during cleanup */
    }
  };

  const init = (async () => {
    const session = await runtime.newSession({ cwd: options.cwd, mcpServers: options.mcpServers });
    const handle = session.prompt(options.prompt);
    handle.then(cleanup, cleanup);
    underlying = handle[Symbol.asyncIterator]();
  })();

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<SessionNotification>> {
      try {
        await init;
        if (!underlying) {
          await cleanup();
          return { value: undefined as unknown as SessionNotification, done: true };
        }
        const result = await underlying.next();
        if (result.done) {
          await cleanup();
        }
        return result;
      } catch (err) {
        await cleanup();
        throw err;
      }
    },
    async return(): Promise<IteratorResult<SessionNotification>> {
      try {
        await underlying?.return?.();
      } finally {
        await cleanup();
      }
      return { value: undefined as unknown as SessionNotification, done: true };
    },
  };
}
