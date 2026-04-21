# API Overview

## Main entry points

```ts
import {
  createAcpRuntime,
  runAcpAgent,
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

// Track 1: normalized events
session.on('event', (event: RuntimeSessionEvent) => {
  // message.delta, reasoning.delta, tool.start, turn.completed, etc.
});

// Track 2: raw ACP notifications for one turn
const handle = session.prompt('Refactor utils.ts');
for await (const n of handle) { /* ... */ }
const result = await handle; // Promise<PromptResult>

await session.cancel(); // optional
// session and runtime are disposed automatically by `await using`
```

## One-shot helper

```ts
for await (const n of runAcpAgent({ profile: 'copilot', cwd, prompt: 'Hi' })) {
  // raw ACP SessionNotification
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
