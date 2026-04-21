# ACP Kit

[![CI](https://github.com/xingsy97/acp-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/xingsy97/acp-kit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40acp-kit%2Fcore.svg?label=%40acp-kit%2Fcore)](https://www.npmjs.com/package/@acp-kit/core)
[![npm downloads](https://img.shields.io/npm/dm/%40acp-kit%2Fcore.svg)](https://www.npmjs.com/package/@acp-kit/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-experimental-orange.svg)](#status)

**ACP Kit is a runtime for building applications on top of the [Agent Client Protocol](https://agentclientprotocol.com/).**

It launches an ACP agent process, manages the protocol connection, handles authentication, exposes host adapters for permissions / files / terminals, and turns raw `session/update` traffic into normalized turn, message, reasoning, and tool events. Your application chooses an agent profile, attaches a host, opens a session, and consumes stable events.

---

## Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Examples](#examples)
- [What ACP Kit Does](#what-acp-kit-does)
- [API Overview](#api-overview)
- [Built-in Agent Profiles](#built-in-agent-profiles)
- [How It Compares to `@agentclientprotocol/sdk`](#how-it-compares-to-agentclientprotocolsdk)
- [Compatibility](#compatibility)
- [Status](#status)
- [Documentation](#documentation)
- [Development](#development)
- [License](#license)

## Install

```bash
npm install @acp-kit/core
```

Requirements:

- Node.js **>= 18**
- A reachable ACP agent CLI (for example Copilot CLI, Claude ACP, Codex ACP) installed on the machine running the runtime

## Quick Start

```ts
import { createRuntime } from '@acp-kit/core';

const runtime = createRuntime({
  profile: 'copilot',
  cwd: process.cwd(),
  host: {
    requestPermission: async () => 'allow_once',
  },
});

const session = await runtime.newSession();

session.on('event', (event) => {
  console.log(event.type, event);
});

await session.prompt('Summarize this repository.');
await session.dispose();
```

That is the complete shape of an ACP Kit application: pick a profile, attach a host adapter, open a session, listen for normalized events.

## Examples

The repository ships with three runnable examples under [`examples/`](examples/). Each one is a standalone npm package that installs the published `@acp-kit/core` from npm:

| Example | Runs without an agent installed | What it shows |
| --- | :---: | --- |
| [`quick-start/`](examples/quick-start/) | No | Minimum runnable mirror of the snippet above. |
| [`mock-runtime/`](examples/mock-runtime/) | **Yes** | Self-contained mock ACP server. Use this to see the full event flow without installing an agent. |
| [`real-agent-cli/`](examples/real-agent-cli/) | No | Interactive CLI driver for real agents (`copilot`, `claude`, `codex`) with prompts for auth and permission decisions. |

```bash
cd examples/mock-runtime
npm install
npm start
```

See [`examples/README.md`](examples/README.md) for details.

## What ACP Kit Does

A real ACP client has to do all of this before it can hold a useful conversation:

- choose which agent implementation to talk to and where it lives on disk
- spawn that agent in a platform-safe way (Windows quirks, login shells, env propagation)
- detect startup failure and surface stderr / exit reasons clearly
- bootstrap an ACP connection with `initialize`
- handle `auth_required` during `session/new`, run an auth method, retry
- create sessions
- expose host adapters (permission prompts, file access, terminal access)
- turn raw `session/update` traffic into stable message / reasoning / tool / usage events
- decide when a turn is actually complete

ACP Kit packages all of the above behind a single `createRuntime({...}).newSession()` call.

## API Overview

```ts
import {
  createRuntime,
  type RuntimeHost,
  type RuntimeSessionEvent,
  type AgentProfile,
} from '@acp-kit/core';

const runtime = createRuntime({
  profile: 'copilot',          // built-in id, or a custom AgentProfile object
  cwd: '/path/to/workspace',
  host: {
    requestPermission: async (req) => 'allow_once',
    chooseAuthMethod:  async ({ methods }) => methods[0]?.id ?? null,
    log:               (event) => console.log(event),
    // Optional: file system + terminal capabilities are advertised to the
    // agent only when the corresponding host methods are provided.
    // readTextFile / writeTextFile take ACP request/response objects from
    // @agentclientprotocol/sdk; createTerminal must be paired with
    // terminalOutput / waitForTerminalExit / killTerminal / releaseTerminal.
  } satisfies RuntimeHost,
});

const session = await runtime.newSession();

session.on('event', (event: RuntimeSessionEvent) => { /* ... */ });

await session.prompt('Refactor utils.ts');
await session.cancel();        // optional: cancel the in-flight turn
await session.dispose();       // tears down the ACP connection and child process
```

The full surface (event types, profile shape, transcript reducer, normalization helpers) is exported from a single entry point: `@acp-kit/core`.

## Built-in Agent Profiles

| Profile id | Agent |
| --- | --- |
| `copilot` | GitHub Copilot CLI in ACP mode |
| `claude` | Claude ACP |
| `codex` | Codex ACP |

Custom profiles are plain objects:

```ts
const myProfile: AgentProfile = {
  id: 'my-agent',
  displayName: 'My Agent',
  command: 'my-agent-cli',
  args: ['--acp'],
  env: { /* optional */ },
};

const runtime = createRuntime({ profile: myProfile, cwd, host });
```

## How It Compares to `@agentclientprotocol/sdk`

ACP Kit is built **on top of** [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk), not as a replacement.

- `@agentclientprotocol/sdk` is the **protocol toolkit**. It gives you `ClientSideConnection`, `ndJsonStream`, typed request/response/notification payloads, and JSON-RPC framing — once you already have a connection to an ACP server.
- ACP Kit is the **client runtime**. It launches the agent, manages the connection lifecycle, runs auth, exposes host adapters, normalizes raw protocol updates into stable events, and tracks turn state.

The protocol layer underneath stays exactly `@agentclientprotocol/sdk`. ACP Kit does not fork it, replace it, or hide it — it depends on it as a regular npm dependency.

```text
┌──────────────────────────────────────────────────────────────────┐
│  Your Product (editor extension, desktop shell, daemon, web …)   │
│  - product UI / state                                            │
│  - product persistence and remote sync                           │
│  - cross-session orchestration                                   │
└───────────────────────────────▲──────────────────────────────────┘
                                │  normalized events:
                                │  message.delta / reasoning.delta
                                │  tool.start / tool.update / tool.end
                                │  turn.started / turn.completed / turn.failed
                                │
┌───────────────────────────────┴──────────────────────────────────┐
│                          ACP Kit                                 │
│  agent profiles · process spawn · startup diagnostics            │
│  auth orchestration · session creation                           │
│  host adapters: permission, fs, terminal                         │
│  session/update normalization · transcript reduction             │
│  turn lifecycle (start / complete / cancel / fail)               │
└───────────────────────────────▲──────────────────────────────────┘
                                │  uses
                                │
┌───────────────────────────────┴──────────────────────────────────┐
│                    @agentclientprotocol/sdk                      │
│  ClientSideConnection · ndJsonStream · JSON-RPC framing          │
│  initialize / session.new / session.prompt · session/update      │
└───────────────────────────────▲──────────────────────────────────┘
                                │  bytes over a transport
                                │  (this repo: child-process stdio)
                                │
┌───────────────────────────────┴──────────────────────────────────┐
│   ACP Server (Copilot CLI --acp, Claude ACP, Codex ACP, …)       │
└──────────────────────────────────────────────────────────────────┘
```

For a deeper walkthrough see [`docs/acp-sdk-vs-runtime.md`](docs/acp-sdk-vs-runtime.md).

## Compatibility

| Dependency | Version |
| --- | --- |
| `@agentclientprotocol/sdk` | `^0.18` |
| Node.js | `>= 18` |
| OS | Windows, macOS, Linux |

ACP Kit aims to track the latest stable `@agentclientprotocol/sdk` minor release. Breaking changes in the SDK will be matched by a minor or major bump in `@acp-kit/core` while v0.x is in effect.

## Status

ACP Kit is **experimental (v0.x)**. The public API may change between minor versions until v1.0.

Implemented today:

- Built-in agent profiles for Copilot, Claude, Codex
- Cross-platform process spawn with startup timeout, stderr capture, and exit diagnostics
- ACP connection bootstrap on top of `@agentclientprotocol/sdk`
- Auth retry when `session/new` returns `auth_required`
- Host adapters for permission, file system, and terminal
- Prompt and cancel lifecycle with normalized turn events
- Transcript reducer with pending-stream completion flushing

Not implemented yet:

- `session/load` resume flows
- Raw traffic taps for debugging
- Higher-level collaboration semantics (delegation, subagents)

See [`docs/migration-plan.md`](docs/migration-plan.md) for how downstream products can adopt the runtime incrementally.

## Documentation

- [`docs/acp-sdk-vs-runtime.md`](docs/acp-sdk-vs-runtime.md) — the boundary between the official SDK and ACP Kit
- [`docs/architecture.md`](docs/architecture.md) — runtime layers and design principles
- [`docs/package-plan.md`](docs/package-plan.md) — why ACP Kit ships as a single package today and when to split
- [`docs/migration-plan.md`](docs/migration-plan.md) — incremental adoption path for existing ACP products

## Development

```bash
npm install        # install workspace deps (packages/core only)
npm run build      # tsc -b packages/core
npm test           # vitest run
```

To try an example:

```bash
cd examples/mock-runtime
npm install
npm start
```

Repository layout:

```text
packages/core/     @acp-kit/core source, tests, build output
docs/              architecture and design notes
examples/          standalone npm packages that depend on the published @acp-kit/core
```

Contributions are welcome. Please open an issue to discuss non-trivial changes before sending a PR.

## License

[MIT](./LICENSE)
