# web-daemon

A tiny HTTP + Server-Sent Events demo on top of `@acp-kit/core`. POST a prompt to `/prompt` and the server streams normalized `RuntimeSessionEvent`s back over SSE until the turn completes.

**This is a demo**, not a production server &mdash; no auth, no concurrency control, no session reuse. Each request opens its own one-shot ACP session via `runOneShotPrompt`. The point is to show how the runtime's normalized event stream maps onto a browser-friendly transport.

## What it shows

- One ~200-line `node:http` server, no framework dependencies.
- `runOneShotPrompt({ agent, cwd, prompt })` driven from an HTTP handler.
- Every `RuntimeSessionEvent` (`message.delta`, `tool.start`, `tool.end`, `turn.completed`, ...) serialized as a single SSE `data:` frame.
- A 30-line HTML page that consumes the stream with `fetch` + a `ReadableStream` reader.
- Client disconnect calls the iterator's `return()`, which shuts down the agent process.

## Run

```bash
npm install
npm start                  # http://localhost:3000
PORT=4000 npm start
```

Open `http://localhost:3000`, pick an agent in the dropdown, type a prompt, hit **Send**.

Or from `curl`:

```bash
curl -N -X POST http://localhost:3000/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"Summarize this repo","agent":"claude"}'
```

> Requires the corresponding agent CLI on `PATH` (default agent: `claude`). Agents available: `copilot`, `claude`, `codex`, `gemini`, `qwen`, `opencode`. To explore the runtime without installing any agent, use [`../mock-runtime/`](../mock-runtime/) instead.

## What to read next

- [`../quick-start/`](../quick-start/) for the same flow without HTTP.
- The `RuntimeSessionEvent` union in [`packages/core/src/runtime-event.ts`](../../packages/core/src/runtime-event.ts) lists every event type the SSE stream can emit.
