# ACP Kit Package Plan

## Current Layout

ACP Kit ships as a single public package: `@acp-kit/core`.

The repository is structured as an npm workspace under `packages/` so additional packages can be added without restructuring the project, but v0.x intentionally publishes only one package.

## Why One Package for Now

ACP Kit could be split into several packages along internal seams (events, normalization, transcript, runtime lifecycle, host adapters). Each of those is a real internal module. None of them yet has a second consumer.

Splitting before a second consumer exists adds cost without benefit:

- two `package.json` files instead of one
- two build outputs to keep in sync
- two version numbers to coordinate on every release
- larger lockfiles and slower installs for downstream users
- more confusing install instructions ("which package do I import from?")

For v0.x the cleaner answer is: one package, clear internal modules, room to split later.

## Internal Modules in `@acp-kit/core`

```text
packages/core/src/
  profiles.ts        agent profile definitions
  host.ts            host adapter interfaces (permission, fs, terminal)
  runtime.ts         process spawn, ACP connection bootstrap, auth, lifecycle
  session.ts         RuntimeSession class: prompt, cancel, turn events
  events.ts          canonical runtime event types
  normalize.ts       raw ACP session/update -> RuntimeEvent[]
  transcript.ts      transcript reducer and pending stream flushing
  session-data.ts    barrel re-export for events / normalize / transcript
  index.ts           public package barrel
```

These are deliberately separate files so that any future package split is a matter of moving files, not refactoring code.

## When to Split

Add a second package only when there is a concrete second consumer that needs strictly less than the full runtime. Examples that would justify a split:

| Trigger | New package |
| --- | --- |
| A consumer wants `normalizeAcpUpdate` + transcript reducer with their own transport (no spawn, no auth) | `@acp-kit/session` (re-extract events / normalize / transcript) |
| A consumer wants to drive ACP over a non-stdio transport (socket, IPC bridge, remote relay) | `@acp-kit/transport-*` |
| Higher-level collaboration semantics emerge (subagents, delegation, parent-child sessions) | `@acp-kit/collab` |

Until at least one of these triggers actually appears, splitting is premature.

## What This Means for the Public API

The public surface of `@acp-kit/core` is the union of:

- runtime lifecycle (`createRuntime`, `RuntimeSession`, host adapters, profiles)
- normalized event types and helpers (`RuntimeEvent`, `normalizeAcpUpdate`, transcript reducer)

All of it is reachable through a single `import { ... } from '@acp-kit/core'`.

## Public API Philosophy

The public API should be boring. It should feel like a predictable runtime, not like a framework that wants to own the whole application.

That means:

- explicit constructor inputs
- explicit host adapters
- explicit event subscription
- minimal hidden global state
- no dependency on UI frameworks
