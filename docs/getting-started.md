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

For a one-shot prompt, use `runAcpAgent`:

```ts
import { runAcpAgent, onSessionUpdate } from '@acp-kit/core';

for await (const n of runAcpAgent({
  profile: 'copilot',
  cwd: process.cwd(),
  prompt: 'Explain what this repository does.',
})) {
  onSessionUpdate(n.update, {
    agentMessageChunk: (u) => process.stdout.write(u.content.text ?? ''),
  });
}
```

For multi-session apps, use `createAcpRuntime` with `await using`:

```ts
import { createAcpRuntime } from '@acp-kit/core';

await using acp = createAcpRuntime({
  profile: 'copilot',
  host: { requestPermission: async () => 'allow_once' },
});

await using session = await acp.newSession({ cwd: process.cwd() });

session.on('event', (event) => {
  if (event.type === 'message.delta') process.stdout.write(event.delta);
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

For the full matrix, see [examples/README.md](https://github.com/xingsy97/acp-kit/blob/main/examples/README.md).
