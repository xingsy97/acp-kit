# Getting Started

ACP Kit is a Node.js runtime for products that need to talk to ACP agents through a stable, high-level API.

## Prerequisites

- Node.js >= 20.11 (uses `await using` / `Symbol.asyncDispose`)
- A reachable ACP-capable agent CLI for real sessions (see [Supported Agents](./agents) for per-agent details)

## Installation

```bash
npm install @acp-kit/core
```

## First session

For a one-shot prompt, use `runOneShotPrompt` (yields normalized `RuntimeSessionEvent`s). Because this helper gives you one event at a time, dispatch each event with `onRuntimeEvent(...)`:

```ts
import { runOneShotPrompt, onRuntimeEvent, ClaudeCode } from '@acp-kit/core';

for await (const event of runOneShotPrompt({
  agent: ClaudeCode,
  cwd: process.cwd(),
  prompt: 'Explain what this repository does.',
})) {
  onRuntimeEvent(event, {
    messageDelta: (e) => process.stdout.write(e.delta),
  });
}
```

For multi-session apps, use `createAcpRuntime` with `await using` and pass a handler map directly to `session.on(...)`:

```ts
import { createAcpRuntime, ClaudeCode } from '@acp-kit/core';

await using acp = createAcpRuntime({
  agent: ClaudeCode,
});

await using session = await acp.newSession({ cwd: process.cwd() });

session.on({
  messageDelta: (e) => process.stdout.write(e.delta),
  toolStart:    (e) => process.stdout.write(`\n[tool ${e.toolCallId}] ${e.title ?? e.name}\n`),
  toolEnd:      (e) => process.stdout.write(`[tool ${e.toolCallId}] ${e.status}\n`),
});

await session.prompt('Explain what this repository does.');
```

By default, the runtime approves tool permissions once and selects the first offered auth method. Pass a `host` when your application needs an explicit approval UI, auth picker, file system adapter, terminal adapter, logging, or wire middleware.

If your UI wants a single turn result while it streams, use `collectTurnResult(...)` instead of manually reducing `messageDelta`, `toolStart`, `toolEnd`, and turn boundary events yourself:

```ts
import { collectTurnResult } from '@acp-kit/core';

const result = await collectTurnResult(session, 'Explain what this repository does.', {
  onUpdate: (snapshot) => render(snapshot.text, snapshot.tools),
});

console.log(result.status, result.stopReason);
```

## Subscribing to events

Use `session.on(...)` when you have a `RuntimeSession`; it subscribes to future events and returns an unsubscribe function. Use `onRuntimeEvent(event, handlers)` only when you already have a single `RuntimeSessionEvent` value and want to route it through the same camelCase handler map, such as inside `runOneShotPrompt(...)`, tests, or a custom event queue.

`session.on(...)` is overloaded three ways:

```ts
// 1. Handler map (most common). Keys are camelCase forms of dotted event types.
//    Each callback is type-narrowed to the matching event variant.
session.on({
  messageDelta:  (e) => /* e: MessageDeltaEvent */ {},
  toolStart:     (e) => /* e: ToolStartEvent    */ {},
  turnCompleted: (e) => /* e: TurnCompletedEvent */ {},
});

// 2. One specific event type.
session.on('tool.start',    (e) => /* e: ToolStartEvent    */ {});
session.on('message.delta', (e) => /* e: MessageDeltaEvent */ {});

// 3. Every event with the full union (useful for logging / persistence).
session.on('event', (e) => /* e: RuntimeSessionEvent */ {});
```

The complete event vocabulary lives in [API Overview &rarr; RuntimeSessionEvent](./api-overview#runtimesessionevent). The most useful ones for UI work:

- `messageDelta` / `messageCompleted` — assistant text
- `reasoningDelta` / `reasoningCompleted` — model "thinking" stream
- `toolStart` / `toolUpdate` / `toolEnd` — tool lifecycle with stable `toolCallId` correlation
- `turnStarted` / `turnCompleted` / `turnCancelled` / `turnFailed` — turn boundaries
- `sessionError` — agent-side error notification

## When the first session fails

Most first-time failures fall into three buckets. Each one surfaces with a clear runtime error you can act on:

### Agent CLI not on `PATH`

```text
Failed to spawn agent "claude-code" (npx @zed-industries/claude-code-acp@latest):
  spawn npx ENOENT
```

The runtime tried to spawn the command in the agent profile and got `ENOENT`. Either install the agent's npm package globally (or rely on `npx` resolving from a registry, which means a working `node` + network), or override `command` / `args` to point at a binary that exists on `PATH`.

### `auth_required` and no `chooseAuthMethod`

```text
ACP session/new failed for agent "claude-code". The agent reported auth_required
but no chooseAuthMethod host method is configured.
```

The agent advertises one or more auth methods. Provide `chooseAuthMethod` in your host:

```ts
host: {
  chooseAuthMethod: async ({ methods }) => methods[0]?.id ?? null,
  // ...
}
```

Returning `null` aborts the session; returning a method `id` triggers the runtime to call `authenticate({ methodId })` and retry `session/new` once.

### Startup timeout

```text
ACP initialize timed out after 30000ms for agent "github-copilot".
Last stderr: <whatever the CLI printed>
```

Either the agent CLI is downloading itself (`npx` first run) or it's hung on an interactive prompt. Run the same `command` / `args` manually in a terminal to see what it's waiting for. If it just needs more time, bump `startupTimeoutMs` on the agent profile (default 30s; built-in profiles use 90s).

For all three buckets, `host.log` is the single best diagnostic hook &mdash; it receives structured records for spawn, connect, init, auth, session create, and exit events.

## Run local examples

Each example is a standalone npm package and depends on the published `@acp-kit/core` package:

```bash
cd examples/mock-runtime
npm install
npm start
```

For the full list, see [examples/README.md](https://github.com/AcpKit/acp-kit/blob/main/examples/README.md).
# Getting Started

ACP Kit is a Node.js runtime for products that need to talk to ACP agents through a stable, high-level API.

## Prerequisites

- Node.js >= 20.11 (uses `await using` / `Symbol.asyncDispose`)
- A reachable ACP-capable agent CLI for real sessions (see [Supported ACP agents](#supported-acp-agents) below)

## Supported ACP agents

ACP Kit can drive any agent that speaks the Agent Client Protocol over stdio. Six agents ship as named constants you import and pass as `agent: <Constant>`; any other ACP-capable agent works via a custom `AgentProfile` literal.

| Agent | Constant |
| --- | --- |
| GitHub Copilot | `GitHubCopilot` |
| Claude Code | `ClaudeCode` |
| Codex CLI | `CodexCli` |
| Gemini CLI | `GeminiCli` |
| Qwen Code | `QwenCode` |
| OpenCode | `OpenCode` |

## Installation

```bash
npm install @acp-kit/core
```

## First session

For a one-shot prompt, use `runOneShotPrompt` (yields normalized `RuntimeSessionEvent`s):

```ts
import { runOneShotPrompt, onRuntimeEvent, ClaudeCode } from '@acp-kit/core';

for await (const event of runOneShotPrompt({
  agent: ClaudeCode,
  cwd: process.cwd(),
  prompt: 'Explain what this repository does.',
})) {
  onRuntimeEvent(event, {
    messageDelta: (e) => process.stdout.write(e.delta),
  });
}
```

For multi-session apps, use `createAcpRuntime` with `await using` and pass a
handler map directly to `session.on(...)`:

```ts
import { createAcpRuntime, ClaudeCode } from '@acp-kit/core';

await using acp = createAcpRuntime({
  agent: ClaudeCode,
});

await using session = await acp.newSession({ cwd: process.cwd() });

session.on({
  messageDelta: (e) => process.stdout.write(e.delta),
  toolStart:    (e) => process.stdout.write(`\n[tool ${e.toolCallId}] ${e.title ?? e.name}\n`),
  toolEnd:      (e) => process.stdout.write(`[tool ${e.toolCallId}] ${e.status}\n`),
});

await session.prompt('Explain what this repository does.');
```

## Run local examples

Each example is a standalone npm package and depends on the published `@acp-kit/core` package:

```bash
cd examples/mock-runtime
npm install
npm start
```

For the full matrix, see [examples/README.md](https://github.com/AcpKit/acp-kit/blob/main/examples/README.md).
