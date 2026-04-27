# ACP Kit Author/Reviewer Loop

A split-context ACP Kit demo that hosts two ACP agents over the same workspace:

- **AUTHOR** modifies files for the requested task.
- **REVIEWER** inspects the working tree in a separate context and replies `APPROVED` or a numbered list of issues.

The two agents share the same workspace, but not the same conversation history. The CLI loops until the reviewer approves the result or `MAX_ROUNDS` is reached. The deliverable is the working tree on disk, not pasted code.

## Run With One Command

```bash
npx @acp-kit/author-reviewer-loop ./demo-workspace "Create a Node.js CLI that counts word frequency from stdin"
```

PowerShell:

```powershell
npx @acp-kit/author-reviewer-loop .\demo-workspace "Create a Node.js CLI that counts word frequency from stdin"
```

Use an empty or disposable directory. The AUTHOR agent is allowed to create and modify files under the target workspace.

Before launching agents, the CLI prints the full run configuration and asks for confirmation. Pass `--yes` or set `ACP_REVIEW_YES=1` to skip the prompt in scripts.

## Requirements

- Node.js >= 20.11
- ACP-capable agent CLIs available on `PATH`
- Login/auth already completed for the selected agents

Defaults:

| Role | Agent | Model |
| --- | --- | --- |
| AUTHOR | GitHub Copilot | `claude-opus-4.7` |
| REVIEWER | Codex | `gpt-5.5` |

Override with environment variables:

```bash
AUTHOR_AGENT=copilot AUTHOR_MODEL=claude-opus-4.7 REVIEWER_AGENT=codex REVIEWER_MODEL=gpt-5.5 \
  npx @acp-kit/author-reviewer-loop ./demo-workspace "Build a small CLI"
```

Supported built-in agent ids: `copilot`, `claude`, `codex`, `gemini`, `qwen`, `opencode`.

## Options

```bash
npx @acp-kit/author-reviewer-loop <cwd> <task> [--yes]
```

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTHOR_AGENT` | `copilot` | Agent that writes/modifies files. |
| `AUTHOR_MODEL` | `claude-opus-4.7` | Model id passed via ACP `session/set_model`; set empty to skip. |
| `REVIEWER_AGENT` | `codex` | Agent that reviews the working tree. |
| `REVIEWER_MODEL` | `gpt-5.5` | Model id passed via ACP `session/set_model`; set empty to skip. |
| `MAX_ROUNDS` | `10` | Maximum author/reviewer iterations. |
| `ACP_REVIEW_YES` | unset | Set to `1` to skip the confirmation prompt. |
| `ACP_REVIEW_TRACE` | unset | Set to `1` to print the runtime inspector JSONL trace on startup failures. |

## What It Shows

- Two `createAcpRuntime(...)` instances, one per agent process.
- Two sessions pointed at the same `cwd`, with separate author/reviewer contexts.
- Per-session model selection via ACP `session/set_model`.
- Handler-map dispatch over normalized `RuntimeSessionEvent`s.
- Startup diagnostics through `isAcpStartupError(...)` and `formatStartupDiagnostics(...)`.
- Runtime inspectors for supportable debugging without adding ad hoc logs.

## Exit Codes

- `0`: reviewer approved the result.
- `1`: maximum rounds reached without approval, startup failed, or a turn failed.