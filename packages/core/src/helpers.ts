import type { McpServer } from '@agentclientprotocol/sdk';

import type { AgentProfile } from './agents.js';
import type { RuntimeHost } from './host.js';
import { createAcpRuntime, type AcpTransport } from './runtime.js';
import type { RuntimeSessionEvent } from './session.js';

export interface RunOneShotPromptOptions {
  agent: AgentProfile;
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
 * One-shot helper: spawn the agent, run a single prompt, yield each
 * `RuntimeSessionEvent` (`message.delta`, `tool.start`, `turn.completed`, ...),
 * and dispose every resource on completion.
 *
 * The agent process is killed when iteration completes (normally or via early
 * `break` / `return`) or when the underlying turn fails or is cancelled.
 *
 * For multi-turn, multi-session, or long-lived hosts use `createAcpRuntime` directly.
 *
 * ```ts
 * import { runOneShotPrompt, ClaudeCode } from '@acp-kit/core';
 *
 * for await (const event of runOneShotPrompt({ agent: ClaudeCode, cwd, prompt: 'Hi' })) {
 *   if (event.type === 'message.delta') process.stdout.write(event.delta);
 * }
 * ```
 */
export function runOneShotPrompt(options: RunOneShotPromptOptions): AsyncIterableIterator<RuntimeSessionEvent> {
  const host: RuntimeHost = options.host ?? {
    requestPermission: async () => 'allow_once',
    chooseAuthMethod: async ({ methods }) => methods[0]?.id ?? null,
  };

  const runtime = createAcpRuntime({
    agent: options.agent,
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
      waiter({ value: undefined as never, done: true });
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
    session.prompt(options.prompt).then(() => finish(), (err) => finish(err));
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