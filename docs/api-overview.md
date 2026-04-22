# API Overview

The complete public surface of `@acp-kit/core`. Everything is exported from a single entry point:

```ts
import {
  // factories
  createAcpRuntime,
  runOneShotPrompt,
  // built-in agents
  ClaudeCode, GitHubCopilot, CodexCli, GeminiCli, QwenCode, OpenCode,
  // wire middleware
  composeWireMiddleware,
  normalizeWireMiddleware,
  // event dispatcher
  onRuntimeEvent,
  RuntimeEventKind,
  // types
  type AgentProfile,
  type RuntimeHost,
  type RuntimeSession,
  type RuntimeSessionEvent,
  type PromptResult,
} from '@acp-kit/core';
```

---

## `createAcpRuntime(options): AcpRuntime`

Create a runtime bound to one agent process. The process and the ACP `initialize` handshake are lazy: they happen on the first `newSession` / `loadSession` / `ready` call.

```ts
await using acp = createAcpRuntime({
  agent: ClaudeCode,            // built-in or custom AgentProfile
  cwd: '/optional/default/cwd', // omit if you pass cwd to every newSession()
  host: { /* RuntimeHost */ },
  transport: undefined,         // override only for browser/IPC transports
});
```

### `RuntimeHost`

The host is a plain object. Every method is optional. Whether the runtime advertises a capability to the agent during `initialize` depends on which methods you provide:

| Field | When to provide |
| --- | --- |
| `chooseAuthMethod(req)` | Always recommended; called when `session/new` returns `auth_required`. Return the `id` of an offered method or `null` to abort. |
| `requestPermission(req)` | Required if the agent uses tools that need user approval. Return `'allow_once' \| 'allow_always' \| 'deny_once' \| 'deny_always'`. |
| `readTextFile(req)` / `writeTextFile(req)` | Provide both to advertise file system capability. Use [`createLocalFileSystemHost({ root })`](https://github.com/xingsy97/acp-kit/blob/main/packages/core/src/hosts/local-fs.ts) for a sandboxed default. |
| `createTerminal` / `terminalOutput` / `waitForTerminalExit` / `killTerminal` / `releaseTerminal` | All five must be provided together to advertise terminal capability. Use [`createLocalTerminalHost`](https://github.com/xingsy97/acp-kit/blob/main/packages/core/src/hosts/local-terminal.ts) as a starting point. |
| `promptCapabilities` | Object with `image` / `audio` / `embeddedContext` booleans (default `false`). Tells the agent what content kinds your UI can render. |
| `log(entry)` | Diagnostic hook. Receives connection / spawn / session lifecycle events as structured records. |
| `wireMiddleware` | Single function or array. Each middleware sees every JSON-RPC frame in either direction with `next` continuation; can observe, mutate, or drop frames. |
| `onAgentExit(info)` | Called by the default node transport when the child agent process exits unexpectedly. |

### Returned `AcpRuntime`

| Member | Meaning |
| --- | --- |
| `acp.newSession({ cwd, mcpServers? })` | Open a new ACP session. Returns a `RuntimeSession`. |
| `acp.loadSession({ sessionId, cwd, mcpServers? })` | Resume an existing session by id. Throws if the agent does not advertise `loadSession`. |
| `acp.listSessions(params?)` | List sessions known to the agent (`session/list`). Throws if the agent does not advertise `sessionCapabilities.list`. Pagination via `nextCursor`. |
| `acp.ready()` | Force the lazy connect / `initialize`. Idempotent. |
| `acp.shutdown()` | Tear down the agent process and all sessions. Idempotent. Called automatically by `await using`. |
| `acp.reconnect()` | Drop the current connection and reconnect on the next call. Application state survives. |
| `acp.agentInfo` | `Implementation` from `initialize`, or `null` before first connect. |
| `acp.authMethods` | Auth methods advertised by the agent. Empty array before first connect. |
| `acp.agentCapabilities` | Full `AgentCapabilities` object from `initialize`. **Inspect this to see what the connected agent CLI version supports.** |
| `acp.protocolVersion` | Negotiated ACP protocol version, or `null`. |
| `acp.isReady` | `true` once the transport has connected and `initialize` completed. |

---

## `RuntimeSession`

Returned by `acp.newSession(...)` / `acp.loadSession(...)`. One session = one ACP `sessionId`.

| Member | Meaning |
| --- | --- |
| `session.sessionId` | The ACP session id. |
| `session.agent` | The `AgentProfile` this session is bound to. |
| `session.transcript` | Live read-only reducer state (messages, reasoning, tool calls, mode/model, usage). Updates in place. |
| `session.getSnapshot()` | Deep clone of the current transcript state. |
| `session.on(handlerMap)` | Subscribe with a camelCase handler map (most common). |
| `session.on(type, listener)` | Subscribe to a single event type with a narrowed listener. |
| `session.on('event', listener)` | Subscribe to every event with the full union. |
| `session.prompt(text)` | Send a prompt. Returns `Promise<PromptResult>`. Throws if a turn is already running. |
| `session.cancel()` | Cancel the in-flight turn. |
| `session.setMode(modeId)` | ACP `session/set_mode`. Throws if the agent does not implement it. |
| `session.setModel(modelId)` | ACP `session/set_model`. Throws if the agent does not implement it. |
| `session[Symbol.asyncDispose]()` | Auto-called by `await using`. Equivalent to closing and detaching listeners. |

### `PromptResult`

```ts
interface PromptResult {
  stopReason: string | null; // 'end_turn' | 'cancelled' | agent-specific | null
}
```

---

## `runOneShotPrompt(options)`

Spawn the agent, run one prompt, yield each `RuntimeSessionEvent`, dispose everything when iteration completes.

```ts
import { runOneShotPrompt, ClaudeCode } from '@acp-kit/core';

for await (const event of runOneShotPrompt({
  agent: ClaudeCode,
  cwd: process.cwd(),
  prompt: 'Hi',
  host,        // optional; defaults to allow_once + first auth method
  mcpServers,  // optional; passed to newSession
  transport,   // optional; default node child-process transport
})) {
  if (event.type === 'message.delta') process.stdout.write(event.delta);
}
```

The agent process is killed on `for await` completion, early `break` / `return`, or turn failure / cancellation.

---

## `RuntimeSessionEvent`

The union emitted by `session.on(...)`. Every event has `type`, `sessionId`, `at` (ms), and optional `turnId`. Camel-case handler keys (used in the handler-map form) are derived from the dotted type:

| Event `type` | Handler key | Payload highlights |
| --- | --- | --- |
| `message.delta` | `messageDelta` | `messageId`, `delta` |
| `message.completed` | `messageCompleted` | `messageId`, `content` |
| `reasoning.delta` | `reasoningDelta` | `reasoningId`, `delta` |
| `reasoning.completed` | `reasoningCompleted` | `reasoningId`, `content` |
| `tool.start` | `toolStart` | `toolCallId`, `name`, `title?`, `kind?`, `status`, `input?`, `meta?` |
| `tool.update` | `toolUpdate` | `toolCallId`, `status`, `output?`, `meta?` |
| `tool.end` | `toolEnd` | `toolCallId`, `status` (`completed`/`failed`), `output?`, `meta?` |
| `turn.started` | `turnStarted` | `turnId` |
| `turn.completed` | `turnCompleted` | `turnId`, `stopReason` |
| `turn.failed` | `turnFailed` | `turnId`, `error` |
| `turn.cancelled` | `turnCancelled` | `turnId`, `reason` |
| `status.changed` | `statusChanged` | `status`, `previousStatus` (`idle`/`running`/`cancelling`/`disposed`) |
| `session.commands.updated` | `sessionCommandsUpdated` | `commands` |
| `session.config.updated` | `sessionConfigUpdated` | `configOptions` |
| `session.modes.updated` | `sessionModesUpdated` | `state` |
| `session.mode.updated` | `sessionModeUpdated` | `currentModeId` |
| `session.models.updated` | `sessionModelsUpdated` | `state` |
| `session.model.updated` | `sessionModelUpdated` | `currentModelId` |
| `session.usage.updated` | `sessionUsageUpdated` | `used?`, `size?`, `cost?` |
| `session.error` | `sessionError` | `message` |

`tool.start` / `tool.update` / `tool.end` carry the agent's `_meta` field verbatim &mdash; vendor-specific affordances pass through unchanged.

The `RuntimeEventKind` const map exposes the literal strings if you need them at runtime:

```ts
import { RuntimeEventKind } from '@acp-kit/core';
if (event.type === RuntimeEventKind.ToolStart) { /* ... */ }
```

---

## Wire middleware

Observe or mutate raw JSON-RPC traffic. Useful for protocol bridges, debug recorders, or vendor adapters that need to rewrite frames the runtime would otherwise pass through unchanged.

```ts
import { composeWireMiddleware, normalizeWireMiddleware } from '@acp-kit/core';

const log = async (ctx, next) => {
  console.log(ctx.direction, ctx.frame.method ?? ctx.frame.id);
  await next();
};

const host: RuntimeHost = {
  wireMiddleware: composeWireMiddleware([log, normalizeWireMiddleware()]),
};
```

`normalizeWireMiddleware` is the same canonicalization the runtime applies internally; include it explicitly if your custom middleware needs to see normalized frames.

---

## Capability boundary

ACP Kit is built on top of [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk):

- The SDK handles protocol-level transport and typed messages.
- ACP Kit handles process lifecycle, auth orchestration, session lifecycle, and event normalization.

Read [SDK vs Runtime](./acp-sdk-vs-runtime.md) for the full boundary.
# API Overview

## Main entry points

```ts
import {
  createAcpRuntime,
  runOneShotPrompt,
  ClaudeCode,
  type RuntimeHost,
  type RuntimeSessionEvent,
  type AgentProfile
} from '@acp-kit/core';
```

## Runtime creation

```ts
await using acp = createAcpRuntime({
  agent: ClaudeCode,
  host: {
    requestPermission: async () => 'allow_once',
    chooseAuthMethod: async ({ methods }) => methods[0]?.id ?? null,
    log: (event) => console.log(event)
  } satisfies RuntimeHost
});
```

## Session lifecycle

```ts
await using session = await acp.newSession({ cwd: '/path/to/workspace' });

// Subscribe to normalized events with a handler map
session.on({
  messageDelta:  (e) => process.stdout.write(e.delta),
  toolStart:     (e) => console.log(`[${e.toolCallId}] ${e.title ?? e.name}`),
  turnCompleted: (e) => console.log(`done: ${e.stopReason}`),
});

const result = await session.prompt('Refactor utils.ts'); // Promise<PromptResult>
await session.cancel(); // optional
// session and runtime are disposed automatically by `await using`
```

## One-shot helper

```ts
for await (const event of runOneShotPrompt({ agent: ClaudeCode, cwd, prompt: 'Hi' })) {
  // RuntimeSessionEvent: message.delta, tool.start, turn.completed, ...
}
```

## Built-in agents

Named constants exported from `@acp-kit/core`:

- `GitHubCopilot`
- `ClaudeCode`
- `CodexCli`
- `GeminiCli`
- `QwenCode`
- `OpenCode`

## Custom agent

```ts
const myAgent: AgentProfile = {
  id: 'my-agent',
  displayName: 'My Agent',
  command: 'my-agent-cli',
  args: ['--acp']
};

await using acp = createAcpRuntime({ agent: myAgent, host: {} });
```

## Capability boundary

ACP Kit is built on top of `@agentclientprotocol/sdk`:

- ACP SDK handles protocol-level transport and typed messages.
- ACP Kit handles process lifecycle, auth orchestration, session lifecycle, and normalized events.

Read [SDK vs Runtime](./acp-sdk-vs-runtime.md) for details.
