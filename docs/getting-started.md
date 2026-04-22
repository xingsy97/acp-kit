# Getting Started

ACP Kit is a Node.js runtime for products that need to talk to ACP agents through a stable, high-level API.

## Prerequisites

- Node.js 18+
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
  host: { requestPermission: async () => 'allow_once' },
});

await using session = await acp.newSession({ cwd: process.cwd() });

session.on({
  messageDelta: (e) => process.stdout.write(e.delta),
  toolStart:    (e) => console.log(`\n[tool ${e.toolCallId}] ${e.title ?? e.name}`),
  toolEnd:      (e) => console.log(`[tool ${e.toolCallId}] ${e.status}`),
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
