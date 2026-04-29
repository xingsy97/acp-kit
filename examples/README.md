# ACP Kit Examples

Each example is a **standalone npm package** that depends on the published [`@acp-kit/core`](https://www.npmjs.com/package/@acp-kit/core). They are not part of the repository workspace, so they consume the same `@acp-kit/core` build any external user would.

| Example | What it shows |
| --- | --- |
| [`quick-start/`](./quick-start/) | The minimum one-shot path: `runOneShotPrompt({ agent, cwd, prompt })` returning an async iterable of normalized `RuntimeSessionEvent`s (`message.delta`, `tool.start`, `turn.completed`, ...). Process is auto-disposed. |
| [`Spar`](../packages/author-reviewer-loop/) | Flagship CLI built on `@acp-kit/core`: AUTHOR writes files, REVIEWER inspects them in a separate context, and the loop continues until `APPROVED`. Demonstrates split-context multi-agent orchestration over one workspace. |
| [`mock-runtime/`](./mock-runtime/) | A fully self-contained mock ACP server so you can see the complete event flow (auth retry, permission, tool lifecycle, message / reasoning / usage updates, transcript snapshot) without installing any agent. |
| [`real-agent-cli/`](./real-agent-cli/) | A small CLI that drives a real ACP agent (Copilot CLI, Claude ACP, Codex ACP) with an interactive host adapter for auth and permission prompts. |
| [`web-daemon/`](./web-daemon/) | Tiny `node:http` + Server-Sent Events server: POST a prompt to `/prompt` and stream normalized events back to a browser or `curl -N`. |

## Running

Each example installs and runs on its own:

```bash
cd examples/mock-runtime
npm install
npm start
```

Same pattern for `quick-start/` and `real-agent-cli/`. The author/reviewer loop is published as a CLI package instead:

```bash
npx @acp-kit/author-reviewer-loop ./demo-workspace "Create a small CLI"
```

## Using an example as a template outside this repo

Each example folder is fully self-contained. Copy it out and run:

```bash
npm install
npm start
```

That is the entire setup.

For the packaged author/reviewer demo, prefer `npx @acp-kit/author-reviewer-loop ...` so you consume the same package external users get.

## Adding a new example

1. Create a new folder under `examples/` named after the scenario (kebab-case).
2. Add a `package.json` with `"name": "@acp-kit/example-<name>"`, `"private": true`, a `start` script, and `"@acp-kit/core": "^x.y.z"` as a dependency.
3. Add an `index.mjs` (or `index.ts`) entry point and a `README.md`.
