# Mock Runtime

A self-contained demo that exercises the full runtime against an in-process mock ACP server. Useful for understanding the event flow before installing any agent CLI, and for verifying the runtime in CI.

## What it shows

- A mock `spawnProcess` and `connectionFactory` that imitate a real ACP server.
- The `auth_required` retry path (the mock fails the first `session/new` and succeeds after authentication).
- Host-driven permission decisions (auto-approved here).
- Normalized turn lifecycle events: `turn.started`, `tool.start` / `tool.update` / `tool.end`, `message.delta`, `reasoning.delta`, `session.usage.updated`, `turn.completed`.
- Final transcript snapshot via `session.getSnapshot()`.

No external agent is required.

## Run

This example is a standalone npm package that depends on the published `@acp-kit/core`. From this folder:

```bash
npm install
npm start
```

No agent installation is needed; the example provides its own in-process mock ACP server.

## Use as a template outside this repo

Copy this folder anywhere, then run the same two commands.
