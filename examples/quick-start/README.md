# Quick Start

The minimum code needed to run a single ACP prompt through ACP Kit. Uses the one-shot `runOneShotPrompt` helper, which spawns the agent, runs one prompt, streams raw ACP `session/update` notifications, and disposes everything when iteration completes.

## What it shows

- Call `runOneShotPrompt({ profile, cwd, prompt })` and iterate the returned async iterable.
- Use `onSessionUpdate(notification.update, { ... })` to dispatch by camelCase variant name &mdash; no string literals, full type narrowing per handler.
- No manual `dispose` / `shutdown` needed.

## Run

```bash
npm install
npm start                                # defaults: profile=claude, prompt="Write a demo for this repo"
npm start -- copilot "Summarize this"    # custom profile + prompt
```

> Requires the corresponding agent CLI on `PATH` (`claude`, `gh copilot`, etc). To explore the runtime without installing any agent, use [`../mock-runtime/`](../mock-runtime/) instead.

## When to graduate to `createAcpRuntime`

Use [`../advanced-multi-session/`](../advanced-multi-session/) once you need:

- More than one prompt per agent process,
- Multiple sessions with different working directories,
- Or explicit lifecycle control via `await using`.
