# Changelog

All notable changes to `@acp-kit/core` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While ACP Kit is in `0.x`, **minor versions may include breaking changes** (per the SemVer 0.x convention). Patch versions remain backward compatible.

## [0.2.2] - 2026-04-22

Patch release. Non-breaking.

### Added

- `RuntimeSession.transcript` &mdash; read-only public getter returning the session's reducer state (messages, reasoning, tool calls, mode / model state, open stream ids, usage). Useful for reading the initial mode / model state populated by `newSession` / `loadSession` before the first handler has a chance to attach, and for rendering UI snapshots mid-stream without resubscribing. Previously only accessible via `getSnapshot()`, which returned a deep clone on each call.

## [0.2.1] - 2026-04-22

Patch release. Non-breaking additions to the normalized event surface so every ACP session update has a typed runtime event and vendor extensions survive the normalization layer.

### Added

- `ToolStartEvent` / `ToolUpdateEvent` / `ToolEndEvent` now carry an optional `meta?: Record<string, unknown>` field, forwarding the raw `_meta` object from the underlying ACP update verbatim. ACP's `_meta` is the spec-defined vendor-extension slot &mdash; consumers that want vendor-specific tool names, arguments, or responses (e.g. `_meta.claudeCode.toolName`) no longer have to attach a wire middleware to reach them.
- New `SessionErrorEvent` (`type: 'session.error'`) mapping ACP's `session_error` session-update variant. `RuntimeEventHandlers.sessionError?: (e) => void` is now part of the handler-map dispatch (`session.on({ sessionError: ... })`), and `RuntimeEventKind.SessionError` is exported.

### Compatibility

Both additions are non-breaking: existing code that did not read `meta` or handle `session.error` continues to work unchanged.

## [0.2.0] - 2026-04-21

Minor release with **breaking changes** (allowed in 0.x). The dual normalized / raw event surface is collapsed into a single normalized track, and the helper is reshaped into an idiomatic handler-map dispatch.

### Changed (breaking)

- **Removed the raw session-update track.** `session.onRawNotification`, `session.events()`, `onRawSessionUpdate`, `SessionUpdateKind`, and `packages/core/src/session-update.ts` are gone. All consumers now go through the normalized `RuntimeSessionEvent` stream (`message.delta`, `tool.start` / `tool.update` / `tool.end`, `turn.completed`, ...). For unfiltered raw access, attach a wire middleware via `createAcpRuntime({ wireMiddleware })`.
- **`session.prompt(text)` returns `Promise<PromptResult>` only.** It no longer doubles as an `AsyncIterable` of `PromptHandle` notifications. Subscribe to events via `session.on(...)` *before* calling `prompt(...)`.
- **Added `session.on(handlers)` overload** that takes a camelCase handler map (`{ messageDelta, toolStart, toolEnd, turnCompleted, ... }`) covering every `RuntimeSessionEvent`. The single-event-type and `'event'` overloads remain.
- **`runOneShotPrompt(...)` now yields normalized `RuntimeSessionEvent`s** instead of raw `PromptHandle` notifications. Same name, same one-shot lifecycle, new payload type.
- **Fixed prototype-strip bug in `transports/node.ts`.** The default node transport was spreading the underlying `ClientSideConnection` into a new object, which silently dropped class-prototype methods like `initialize` and `prompt`. The transport now mutates `dispose` in place to keep the original instance intact.

### Examples

- New **`examples/pair-programming/`** &mdash; two ACP agents (AUTHOR + REVIEWER) collaborating on the same `cwd` until the reviewer says `APPROVED`. Demonstrates per-role profile + model + prompt settings, parallel agent launch, and handler-map event dispatch.
- Removed `examples/advanced-multi-session/` (superseded by `pair-programming/`, which is a stronger multi-session demo).
- `examples/quick-start/` and all docs migrated to `runOneShotPrompt` + `session.on({ ... })` handler-map style.

## [0.1.4] - 2026-04-23

Patch release. Naming-only change: the one-shot helper is renamed to better describe what it does.

### Changed (breaking)

- `runAcpAgent(...)` and the `RunAcpAgentOptions` interface are renamed to **`runOneShotPrompt(...)`** / **`RunOneShotPromptOptions`**. The shape, behavior, and return type are unchanged. The old name returned an async iterable that spawned an agent, ran a single prompt, and disposed everything on completion — but "agent" referred to the *remote* process, not the helper itself, and "run" suggested a long-lived thing. The new name describes the actual lifecycle: **one prompt, then teardown**. Migration is a single find-and-replace.

## [0.1.3] - 2026-04-23

Patch release. No breaking changes — existing `createAcpRuntime` / `runAcpAgent` / `session.prompt(...)` code keeps working unchanged.

This release makes `AcpRuntime` actually behave the way the README promised: **one runtime owns one agent subprocess, and that subprocess hosts as many ACP sessions as you create**. Previously, every call to `acp.newSession(...)` spawned a fresh process and ran a full `initialize` handshake. Now `initialize` happens once on the first `newSession` / `loadSession` / `ready()` call, and every subsequent session reuses the same connection.

### Added

- `acp.loadSession({ sessionId, cwd?, mcpServers? })` — resume a previously created ACP session by id. Throws if the agent does not advertise the `loadSession` capability.
- `acp.ready()` — explicitly spawn the agent process and complete `initialize` without creating a session yet. Useful for warming up or for inspecting `agentInfo` / `authMethods` before deciding what to do.
- `acp.isReady` — boolean getter, `true` once the agent has been initialized.
- `acp.agentInfo`, `acp.authMethods`, `acp.agentCapabilities`, `acp.protocolVersion` — agent metadata returned by `initialize`. `null` / empty until the runtime has connected.
- `NewSessionOptions.mcpServers?: McpServer[]` and `LoadSessionOptions.mcpServers?: McpServer[]` — properly typed (was `unknown[]`). Forwarded to ACP `session/new` and `session/load` respectively.
- `AcpConnectionFactory.create(...).loadSession?(...)` — optional capability used by `acp.loadSession`.

### Changed (non-breaking)

- One agent subprocess per `AcpRuntime` (was: one per session). `acp.shutdown()` still tears everything down the same way; `session.dispose()` no longer closes the underlying process — the runtime owns its lifecycle.
- The `auth_required` retry path is now a shared internal helper used by both `newSession` and `loadSession`.
- ACP `session/update` notifications are now routed to the matching session via the notification's own `sessionId`, instead of being assumed to belong to a single session.

### Tests

- Added coverage for: shared-process behavior across multiple sessions, `agentInfo` / `authMethods` / `agentCapabilities` exposure, `session/update` routing across two concurrent sessions, `loadSession` happy path, and the `loadSession` capability check.

## [0.1.2] - 2026-04-22

This release reshapes the public API around two ergonomic entry points and aligns the streaming surface with raw ACP. `createRuntime` from 0.1.x stays exported as an alias for `createAcpRuntime`; everything else listed under "breaking" below is a hard change.

### Added

- `createAcpRuntime(options)` — primary entry point. Returns an `AcpRuntime` that owns one agent subprocess and can host multiple sessions.
- `runAcpAgent({ profile, cwd, prompt, host?, ... })` — one-shot helper that returns `AsyncIterable<SessionNotification>` and tears down the runtime when iteration ends. *(Renamed to `runOneShotPrompt` in 0.1.4.)*
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
