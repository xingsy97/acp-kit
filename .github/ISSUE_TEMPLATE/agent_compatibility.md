---
name: Agent compatibility report
about: Report verified or broken behavior with a specific ACP agent CLI version
labels: agent-compatibility
---

**Agent**

- Built-in profile (or `custom`): <!-- e.g. ClaudeCode / GitHubCopilot / CodexCli / GeminiCli / QwenCode / OpenCode / custom -->
- Agent CLI command: <!-- e.g. `claude-code-acp` -->
- Agent CLI version: <!-- e.g. claude-code-acp 0.4.2 -->

**Environment**

- `@acp-kit/core` version:
- `@agentclientprotocol/sdk` version:
- Node.js version:
- OS:

**Capabilities verified**

Tick what you tested end-to-end and what worked / did not work.

- [ ] `session/new`
- [ ] `session/load` (resume)
- [ ] `session/cancel`
- [ ] `setMode`
- [ ] `setModel`
- [ ] Tool lifecycle (`tool.start` / `tool.update` / `tool.end`)
- [ ] Permission prompts (`requestPermission`)
- [ ] File system host adapter (`readTextFile` / `writeTextFile`)
- [ ] Terminal host adapter (`createTerminal` / `terminalOutput` / `waitForTerminalExit` / `killTerminal` / `releaseTerminal`)
- [ ] Auth retry on `auth_required`

**Result**

What worked, what did not, and any error output.

```text
<!-- paste relevant logs or error messages -->
```

**Reproduction**

Minimal script (preferably based on `examples/quick-start/` or `examples/real-agent-cli/`).

```ts
// minimal repro
```

**Notes**

Anything else useful for the matrix entry &mdash; e.g. agent advertised capabilities (`agentCapabilities`), modes / models exposed, vendor `_meta` quirks.
