# Getting Started

ACP Kit is a Node.js runtime for products that need to talk to ACP agents through a stable, high-level API.

## Prerequisites

- Node.js 18+
- A reachable ACP-capable agent CLI for real sessions (Copilot CLI, Claude ACP, or Codex ACP)

## Installation

```bash
npm install @acp-kit/core
```

## First session

For a one-shot prompt, use `runOneShotPrompt` (yields **raw** ACP notifications):

```ts
import { runOneShotPrompt, onRawSessionUpdate } from '@acp-kit/core';

for await (const n of runOneShotPrompt({
  profile: 'copilot',
  cwd: process.cwd(),
  prompt: 'Explain what this repository does.',
})) {
  onRawSessionUpdate(n.update, {
    agentMessageChunk: (u) => process.stdout.write(u.content.text ?? ''),
  });
}
```

For multi-session apps, use `createAcpRuntime` with `await using` and the
**normalized** event surface:

```ts
import { createAcpRuntime, onRuntimeEvent } from '@acp-kit/core';

await using acp = createAcpRuntime({
  profile: 'copilot',
  host: { requestPermission: async () => 'allow_once' },
});

await using session = await acp.newSession({ cwd: process.cwd() });

session.on('event', (event) => onRuntimeEvent(event, {
  messageDelta: (e) => process.stdout.write(e.delta),
  toolStart:    (e) => console.log(`\n[tool ${e.toolCallId}] ${e.title ?? e.name}`),
  toolEnd:      (e) => console.log(`[tool ${e.toolCallId}] ${e.status}`),
}));

await session.prompt('Explain what this repository does.');
```

## Run local examples

Each example is a standalone npm package and depends on the published `@acp-kit/core` package:

```bash
cd examples/mock-runtime
npm install
npm start
```

For the full matrix, see [examples/README.md](https://github.com/xingsy97/acp-kit/blob/main/examples/README.md).
