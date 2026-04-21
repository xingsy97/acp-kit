# Changelog

All notable changes to `@acp-kit/core` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While ACP Kit is in `0.x`, **minor versions may include breaking changes** (per the SemVer 0.x convention). Patch versions remain backward compatible.

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

[0.1.1]: https://github.com/xingsy97/acp-kit/releases/tag/v0.1.1
[0.1.0]: https://github.com/xingsy97/acp-kit/releases/tag/v0.1.0
