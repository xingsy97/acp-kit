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

The task argument may be inline text or a relative/absolute path to a UTF-8 text file. If it resolves to a file, the task is read once at startup and that in-memory text is used for the rest of the run.

After the initial confirmation, the demo approves agent file-system and terminal requests for the selected workspace so the loop can run unattended. Use a disposable workspace and only run agents you trust.

Before launching agents, the CLI shows the full run configuration and asks for confirmation. Pass `--yes` or set `ACP_REVIEW_YES=1` to skip the prompt in scripts.

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
AUTHOR_AGENT='copilot' AUTHOR_MODEL='claude-opus-4.7' REVIEWER_AGENT='codex' REVIEWER_MODEL='gpt-5.5' \
  npx @acp-kit/author-reviewer-loop ./demo-workspace "Build a small CLI"
```

PowerShell:

```powershell
$Env:AUTHOR_AGENT='copilot'
$Env:AUTHOR_MODEL='claude-opus-4.7'
$Env:REVIEWER_AGENT='codex'
$Env:REVIEWER_MODEL='gpt-5.5'
npx @acp-kit/author-reviewer-loop .\demo-workspace "Build a small CLI"
```

Set `AUTHOR_MODEL=''` or `REVIEWER_MODEL=''` to use that agent's default model. When an agent reports its available models, the CLI validates the configured model before Round 1 starts. If the configured model is not available, startup fails with the agent's model list and an environment variable example formatted for the current shell (`$Env:NAME='value'` in PowerShell, `export NAME='value'` in Unix-like shells).

Supported built-in agent ids: `copilot`, `claude`, `codex`, `gemini`, `qwen`, `opencode`.

## Options

```bash
npx @acp-kit/author-reviewer-loop <cwd> <task-or-task-file> [--yes] [--cli]
```

The Ink-based fullscreen TUI is the default renderer. Pass `--cli` (or set `ACP_REVIEW_CLI=1`) to use the plain line-based renderer instead. `--tui` and `ACP_REVIEW_TUI=1` are still accepted for compatibility.

- The TUI uses the terminal's alternate screen buffer, so it always occupies the entire visible viewport and never grows past the bottom of the screen. Your scrollback is restored on exit.
- A split view shows AUTHOR on the left and REVIEWER on the right; each pane has a fixed height computed from the current terminal size and scrolls internally as new output arrives.
- The header shows `cwd`, the task, max rounds, and a combined AUTHOR/REVIEWER status row with agent and model names.
- Each AUTHOR/REVIEWER pane header shows cumulative input/output token usage as `In/Out 10.53M/0.5M Tk` when the agent reports ACP prompt usage.
- Pane output soft-wraps by default and is pre-wrapped to whole words before rendering.
- Tool-call rows include the command/input preview and output preview when available. Bursts of more than three continuous tool-call rows are collapsed into a compact success/failure summary so tool-heavy turns do not flood the pane.
- Press `[` / `]` to select a concrete tool call in the focused pane, then `Enter` or `d` to inspect its full input and output. `Esc` or `q` returns to the flow view.
- The raw ACP trace view pretty-prints each wire frame as readable multi-line JSON instead of a single long line.
- Resizing the terminal re-flows the layout immediately.

Keybindings:

| Key | Action |
| --- | --- |
| `←` / `→` | Move between rounds |
| `↑` / `↓` (or `j`/`k`) | Scroll the focused pane by one line |
| `PgUp` / `PgDn` | Scroll the focused pane by ten lines |
| `Tab` | Switch focus between AUTHOR and REVIEWER |
| `g` | Jump to the latest round and re-enable follow-mode |
| `G` | Reset scroll to the bottom of the focused pane |
| `[` / `]` | Select previous/next tool call in the focused pane |
| `Enter` / `d` | Open the selected tool call detail view |
| `Esc` / `q` | Return from the tool call detail view |
| `t` | Toggle the raw ACP trace view |
| `w` | Toggle soft-wrap for long lines |
| `?` | Toggle the help overlay |
| `f` | Force another AUTHOR/REVIEWER round after reviewer approval |
| `q` | Quit (only after the run has completed) |

The plain console renderer also includes tool command/output previews and collapses continuous tool-event bursts after three lines.

## Architecture

The package is split into a renderer-agnostic engine and a thin renderer layer:

- `lib/engine.mjs` exposes `createLoopEngine({ config })`, which owns the AUTHOR/REVIEWER business loop, normalized event stream, and a reduced state tree (`engine.getState()` / `engine.subscribe(fn)` / `engine.onEvent(fn)`). It contains no presentation logic.
- `lib/renderers/plain.mjs` subscribes to engine events and prints them as a scrolling line log.
- `lib/renderers/tui.mjs` subscribes to engine events and state and draws a fullscreen Ink view.
- `lib/cli/` contains argument parsing, env parsing, confirmation, run summaries, and error formatting.
- `lib/runtime/` contains ACP role/session startup and per-turn event normalization.
- `lib/config/` contains built-in agent/default settings.
- `lib/config/shell.mjs` formats shell-appropriate environment variable examples for startup errors.
- `lib/runtime/loop.mjs` keeps the legacy `runAuthorReviewerLoop({ config, renderer })` signature working for callers that pass a renderer object with `onTurnStart`, `onMessageDelta`, etc.

To add a new renderer (HTML report, JSONL log, web dashboard), subscribe to `engine.onEvent` and/or read `engine.getState()`. No engine changes are needed.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTHOR_AGENT` | `copilot` | Agent that writes/modifies files. |
| `AUTHOR_MODEL` | `claude-opus-4.7` | Model id passed via ACP `session/set_model`; set empty to skip. |
| `REVIEWER_AGENT` | `codex` | Agent that reviews the working tree. |
| `REVIEWER_MODEL` | `gpt-5.5` | Model id passed via ACP `session/set_model`; set empty to skip. |
| `MAX_ROUNDS` | `10` | Maximum author/reviewer iterations. |
| `ACP_REVIEW_YES` | unset | Set to `1` to skip the confirmation prompt. |
| `ACP_REVIEW_CLI` | unset | Set to `1` to use the plain line-based renderer (same as `--cli`). |
| `ACP_REVIEW_TUI` | unset | Compatibility flag for the default Ink TUI renderer (same as `--tui`). |
| `ACP_REVIEW_TRACE` | unset | Set to `1` to print the runtime inspector JSONL trace on startup failures. |
| `ACP_REVIEW_EDITOR_TIMEOUT_MS` | `1800000` | Maximum time the TUI waits for the external task editor before restoring the screen and reporting an error. |

## What It Shows

- Two `createAcpRuntime(...)` instances, one per agent process.
- Two sessions pointed at the same `cwd`, with separate author/reviewer contexts.
- Per-session model selection via ACP `session/set_model`.
- Startup model validation against each agent's advertised model list when available.
- Handler-map dispatch over normalized `RuntimeSessionEvent`s.
- `collectTurnResult(...)` from `@acp-kit/core`, used to collect a single streamed turn into text/tool/status snapshots for renderers.
- Startup diagnostics through `isAcpStartupError(...)` and `formatStartupDiagnostics(...)`.
- Runtime inspectors for supportable debugging without adding ad hoc logs.

## Exit Codes

- `0`: reviewer approved the result.
- `1`: maximum rounds reached without approval, startup failed, or a turn failed.
