# Changelog

All notable changes to `@acp-kit/core` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While ACP Kit is in `0.x`, **minor versions may include breaking changes** (per the SemVer 0.x convention). Patch versions remain backward compatible.

## [0.1.2] - 2026-04-22

This release reshapes the public API around two ergonomic entry points and aligns the streaming surface with raw ACP. `createRuntime` from 0.1.x stays exported as an alias for `createAcpRuntime`; everything else listed under "breaking" below is a hard change.

### Added

- `createAcpRuntime(options)` — primary entry point. Returns an `AcpRuntime` that owns one agent subprocess and can host multiple sessions.
- `runAcpAgent({ profile, cwd, prompt, host?, ... })` — one-shot helper that returns `AsyncIterable<SessionNotification>` and tears down the runtime when iteration ends.
- `Symbol.asyncDispose` on both `AcpRuntime` and `RuntimeSession`. Use `await using acp = createAcpRuntime(...)` and `await using session = await acp.newSession({ cwd })` to get automatic cleanup. Requires Node ≥ 20.11 (or TypeScript 5.2+ down-leveling).
- `acp.shutdown()` — explicit, idempotent runtime teardown when `await using` is not available.
- `session.prompt(text)` now returns a `PromptHandle` that is **both** a `Promise<PromptResult>` **and** an `AsyncIterable<SessionNotification>` for the turn. Iterate it to consume raw ACP notifications, or `await` it for the final result.
- `session.events()` — `AsyncIterable<SessionNotification>` for the lifetime of the session.
- `session.onRawNotification(fn)` — listener form of the raw stream.
- `examples/advanced-multi-session/` — demonstrates one runtime hosting two `await using` sessions over different `cwd`s.

### Changed (breaking)

- `RuntimeOptions.cwd` removed. Pass `cwd` per session via `acp.newSession({ cwd })`.
- `createRuntime` is now a thin alias for `createAcpRuntime`. New code should prefer `createAcpRuntime`.
- `session.prompt(text)` previously returned `Promise<PromptResult>`. It now returns a `PromptHandle`. Existing `await session.prompt(...)` code keeps working unchanged.
- `examples/quick-start/` rewritten around `runAcpAgent`. `examples/real-agent-cli/` and `examples/mock-runtime/` migrated to `createAcpRuntime` + per-session `cwd`.

### Docs

- README, package README, and the doc site (`docs/`) rewritten around the dual-track API and the real ACP `session/update` discriminators (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `agent_thought_chunk`, ...).

## [0.1.1] - 2026-04-21

### Added

- `author: "ACP Kit contributors"` in `packages/core/package.json` so the npm page no longer shows a personal username as the package author.
- Restructured `examples/` into three focused, self-contained scenarios:
  - [`examples/quick-start/`](examples/quick-start/) — minimal runnable mirror of the README Quick Start.
  - [`examples/mock-runtime/`](examples/mock-runtime/) — fully self-contained mock ACP server, runs without any agent installed (`npm run demo`).
  - [`examples/real-agent-cli/`](examples/real-agent-cli/) — interactive CLI driver against real ACP agents (`npm run demo:real`).
- New root scripts: `demo:quick-start`, `demo:real`.
- `examples/README.md` index.

### Removed

- `examples/runtime-demo.mjs` (replaced by the three focused examples above).

## [0.1.0] - 2026-04-21

Initial public release.

### Added

- `@acp-kit/core` package: a single-package runtime built on `@agentclientprotocol/sdk`.
- `createRuntime({ profile, cwd, host })` entry point.
- Built-in agent profiles for Copilot CLI, Claude ACP, and Codex ACP.
- Cross-platform process spawn with startup timeout, stderr capture, and exit diagnostics.
- ACP connection bootstrap: `initialize`, `session/new`, `session/prompt`, `session/cancel`.
- Auth retry when `session/new` returns `auth_required`, via host `chooseAuthMethod` callback.
- Host adapters: `requestPermission`, `chooseAuthMethod`, `readTextFile`, `writeTextFile`, `createTerminal`, `log`.
- Normalized runtime events for messages, reasoning, tools, usage, mode/model updates.
- Transcript reducer with pending stream completion flushing for clean turn finalization.
- Mock + real-agent runnable demo at `examples/runtime-demo.mjs`.

[0.1.2]: https://github.com/xingsy97/acp-kit/releases/tag/v0.1.2
[0.1.1]: https://github.com/xingsy97/acp-kit/releases/tag/v0.1.1
[0.1.0]: https://github.com/xingsy97/acp-kit/releases/tag/v0.1.0
