# Quick Start

The minimum code needed to run a single ACP prompt through ACP Kit. Uses the one-shot `runOneShotPrompt` helper, which spawns the agent, runs one prompt, streams normalized session events, and disposes everything when iteration completes.

## What it shows

- Call `runOneShotPrompt({ agent, cwd, prompt })` and iterate the returned async iterable of `RuntimeSessionEvent`s.
- Use `onRuntimeEvent(event, { ... })` to dispatch by camelCase name (`messageDelta`, `toolStart`, ...) &mdash; no string literals, full type narrowing per handler.
- No manual `dispose` / `shutdown` needed.

## Run

```bash
npm install
npm start                                # defaults: agent=claude, prompt="Write a demo for this repo"
npm start -- copilot "Summarize this"    # custom agent + prompt
```

> Requires the corresponding agent CLI on `PATH` (`claude`, `gh copilot`, etc). To explore the runtime without installing any agent, use [`../mock-runtime/`](../mock-runtime/) instead.

## When to graduate to `createAcpRuntime`

Use [Spar](../../packages/author-reviewer-loop/) once you need:

- More than one prompt per agent process,
- Multiple sessions with different working directories,