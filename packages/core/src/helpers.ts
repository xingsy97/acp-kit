import type { McpServer, SessionNotification } from '@agentclientprotocol/sdk';

import type { RuntimeHost } from './host.js';
import type { AgentProfile, BuiltInProfileId } from './profiles.js';
import { createAcpRuntime, type SpawnProcess, type AcpConnectionFactory } from './runtime.js';

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
  spawnProcess?: SpawnProcess;
  connectionFactory?: AcpConnectionFactory;
}

/**
 * One-shot helper: spawn the agent, run a single prompt, and dispose every resource on completion.
 *
 * Returns an async iterable of raw ACP `session/update` notifications. The agent process is killed
 * when iteration completes (normally or via early `break` / `return`) or when the underlying turn
 * fails or is cancelled.
 *
 * For multi-turn, multi-session, or long-lived hosts use `createAcpRuntime` directly.
 */
export function runOneShotPrompt(options: RunOneShotPromptOptions): AsyncIterableIterator<SessionNotification> {
  const host: RuntimeHost = options.host ?? {
    requestPermission: async () => 'allow_once',
    chooseAuthMethod: async ({ methods }) => methods[0]?.id ?? null,
  };

  const runtime = createAcpRuntime({
    profile: options.profile,
    host,
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
