# API Overview

## Main entry points

```ts
import {
  createAcpRuntime,
  runOneShotPrompt,
  type RuntimeHost,
  type RuntimeSessionEvent,
  type AgentProfile
} from '@acp-kit/core';
```

## Runtime creation

```ts
await using acp = createAcpRuntime({
  profile: 'copilot',
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
for await (const event of runOneShotPrompt({ profile: 'copilot', cwd, prompt: 'Hi' })) {
  // RuntimeSessionEvent: message.delta, tool.start, turn.completed, ...
}
```

## Built-in profiles

- `copilot`
- `claude`
- `codex`

## Custom profile

```ts
const profile: AgentProfile = {
  id: 'my-agent',
  displayName: 'My Agent',
  command: 'my-agent-cli',
  args: ['--acp']
};

await using acp = createAcpRuntime({ profile, host: {} });
```

## Capability boundary

ACP Kit is built on top of `@agentclientprotocol/sdk`:

- ACP SDK handles protocol-level transport and typed messages.
- ACP Kit handles process lifecycle, auth orchestration, session lifecycle, and normalized events.

Read [SDK vs Runtime](./acp-sdk-vs-runtime.md) for details.
