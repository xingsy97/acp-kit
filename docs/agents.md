# Supported ACP Agents

ACP Kit ships six built-in `AgentProfile` constants. Each one is a small object describing how to spawn the corresponding ACP-capable CLI. You can use them directly, spread them to override one field, or write your own `AgentProfile` literal for any other agent that speaks ACP over stdio.

Built-in profiles spawn the CLI binary from `PATH` instead of `npx <package>@latest`. This avoids an npm registry/version-resolution step on every agent launch; install the corresponding npm package globally or override `command` / `args` if you prefer a pinned local wrapper. When the primary command is not found on `PATH`, built-in profiles include `fallbackCommands` that attempt `npx --yes <package>@latest` automatically so first-run package installation cannot hang on npm's confirmation prompt.

```ts
import { createAcpRuntime, ClaudeCode } from '@acp-kit/core';

await using acp = createAcpRuntime({ agent: ClaudeCode, host });
```

The runtime forwards every standard ACP feature (`session/load`, `setMode`, `setModel`, `session/list`, file system, terminal capabilities) to whichever agent advertises it during `initialize`. Read `acp.agentCapabilities` after the first session is created to see exactly what a given agent CLI version supports today.

---

## Claude Code

```ts
import { ClaudeCode } from '@acp-kit/core';
```

| Field | Value |
| --- | --- |
| `id` | `claude-code` |
| `displayName` | `Claude Code` |
| `command` | `claude-code-acp` |
| `args` | `[]` |
| `startupTimeoutMs` | `30000` |
| Login | Anthropic API key in `ANTHROPIC_API_KEY`, or interactive Claude.ai login on first run |
| Upstream | [`@zed-industries/claude-code-acp`](https://www.npmjs.com/package/@zed-industries/claude-code-acp) |

Anthropic Claude Code via the Zed-maintained ACP wrapper.

---

## GitHub Copilot

```ts
import { GitHubCopilot } from '@acp-kit/core';
```

| Field | Value |
| --- | --- |
| `id` | `github-copilot` |
| `displayName` | `GitHub Copilot` |
| `command` | `copilot-language-server` |
| `args` | `['--acp']` |
| `startupTimeoutMs` | `30000` |
| Login | GitHub OAuth device flow on first run; token cached by the language server |
| Upstream | [`@github/copilot-language-server`](https://www.npmjs.com/package/@github/copilot-language-server) |

GitHub Copilot's language server in ACP mode. Requires an active Copilot subscription on the signed-in GitHub account.

---

## Codex CLI

```ts
import { CodexCli } from '@acp-kit/core';
```

| Field | Value |
| --- | --- |
| `id` | `codex-cli` |
| `displayName` | `Codex CLI` |
| `command` | `codex-acp` |
| `args` | `[]` |
| `startupTimeoutMs` | `30000` |
| Login | OpenAI API key in `OPENAI_API_KEY` |
| Upstream | [`@zed-industries/codex-acp`](https://www.npmjs.com/package/@zed-industries/codex-acp) |

OpenAI Codex CLI via the Zed-maintained ACP wrapper.

---

## Gemini CLI

```ts
import { GeminiCli } from '@acp-kit/core';
```

| Field | Value |
| --- | --- |
| `id` | `gemini-cli` |
| `displayName` | `Gemini CLI` |
| `command` | `gemini` |
| `args` | `['--experimental-acp']` |
| `startupTimeoutMs` | `30000` |
| Login | Google API key in `GEMINI_API_KEY`, or `gcloud auth` for ADC |
| Upstream | [`@google/gemini-cli`](https://www.npmjs.com/package/@google/gemini-cli) |

Google Gemini CLI in experimental ACP mode. The `--experimental-acp` flag means upstream may break compatibility between minor versions; pin a specific CLI version in production.

---

## Qwen Code

```ts
import { QwenCode } from '@acp-kit/core';
```

| Field | Value |
| --- | --- |
| `id` | `qwen-code` |
| `displayName` | `Qwen Code` |
| `command` | `qwen` |
| `args` | `['--acp', '--experimental-skills']` |
| `startupTimeoutMs` | `30000` |
| Login | Alibaba DashScope API key in `DASHSCOPE_API_KEY` (or the CLI's interactive setup) |
| Upstream | [`@qwen-code/qwen-code`](https://www.npmjs.com/package/@qwen-code/qwen-code) |

Alibaba Qwen Code in ACP mode with the experimental skills feature enabled.

---

## OpenCode

```ts
import { OpenCode } from '@acp-kit/core';
```

| Field | Value |
| --- | --- |
| `id` | `opencode` |
| `displayName` | `OpenCode` |
| `command` | `opencode` |
| `args` | `['acp']` |
| `startupTimeoutMs` | `30000` |
| Login | Provider keys configured via `opencode auth login` (multi-provider; reads from OpenCode's config) |
| Upstream | [`opencode-ai`](https://www.npmjs.com/package/opencode-ai) |

OpenCode CLI in ACP mode.

---

## Overriding a built-in profile

Spread the constant and replace any field. The runtime clones `args` and `env` internally, so the original constant stays untouched.

```ts
import { createAcpRuntime, ClaudeCode } from '@acp-kit/core';

await using acp = createAcpRuntime({
  agent: {
    ...ClaudeCode,
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
    startupTimeoutMs: 60000,
  },
  host,
});
```

`startupTimeoutMs` defaults to 30000 on built-in profiles but is not capped; raise it for slow first-run downloads or authentication-heavy startup flows.

## Custom `AgentProfile`

Any binary that implements ACP over stdio works. The full interface:

```ts
interface AgentProfile {
  id: string;                       // stable id, surfaced in errors
  displayName: string;              // human-readable name
  command: string;                  // executable, resolved through PATH
  args: string[];
  fallbackCommands?: Array<{ command: string; args: string[] }>; // slower fallback launches, e.g. npx --yes
  env?: Record<string, string>;     // merged onto process.env
  startupTimeoutMs?: number;        // default 30000
  filterStdoutLine?: (line: string) => string | null; // drop chatty banners
}

const myAgent: AgentProfile = {
  id: 'my-agent',
  displayName: 'My Agent',
  command: 'my-agent-cli',
  args: ['--acp'],
};

await using acp = createAcpRuntime({ agent: myAgent, host });
```

Use `filterStdoutLine` for agents that print non-protocol lines on the same channel as JSON-RPC frames. Return `null` to drop a line, or a transformed string to keep it.
