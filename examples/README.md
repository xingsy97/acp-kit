# ACP Kit Examples

Each example is a **standalone npm package** that depends on the published [`@acp-kit/core`](https://www.npmjs.com/package/@acp-kit/core). They are not part of the repository workspace, so they consume the same `@acp-kit/core` build any external user would.

| Example | Runs without an agent installed | What it shows |
| --- | :---: | --- |
| [`quick-start/`](./quick-start/) | No | The minimum one-shot path: `runOneShotPrompt({ profile, cwd, prompt })` returning an async iterable of normalized `RuntimeSessionEvent`s (`message.delta`, `tool.start`, `turn.completed`, ...). Process is auto-disposed. |
| [`pair-programming/`](./pair-programming/) | No | Two sessions in one runtime as AUTHOR + REVIEWER, looping until the reviewer says `APPROVED`. Demonstrates handler-map dispatch and multi-turn `session.prompt(...)` orchestration. |
| [`mock-runtime/`](./mock-runtime/) | **Yes** | A fully self-contained mock ACP server so you can see the complete event flow (auth retry, permission, tool lifecycle, message / reasoning / usage updates, transcript snapshot) without installing any agent. |
| [`real-agent-cli/`](./real-agent-cli/) | No | A small CLI that drives a real ACP agent (Copilot CLI, Claude ACP, Codex ACP) with an interactive host adapter for auth and permission prompts. |

## Running

Each example installs and runs on its own:

```bash
cd examples/mock-runtime
npm install
npm start
```

Same pattern for `quick-start/` and `real-agent-cli/`.

## Using an example as a template outside this repo

Each folder is fully self-contained. Copy it out and run:

```bash
npm install
npm start
```

That is the entire setup.

## Adding a new example

1. Create a new folder under `examples/` named after the scenario (kebab-case).
2. Add a `package.json` with `"name": "@acp-kit/example-<name>"`, `"private": true`, a `start` script, and `"@acp-kit/core": "^x.y.z"` as a dependency.
3. Add an `index.mjs` (or `index.ts`) entry point and a `README.md`.
