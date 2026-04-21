# Quick Start

The minimum code needed to run an ACP session through ACP Kit. This file is the runnable version of the snippet in the repository [README](../../README.md#quick-start).

## What it shows

- Create a runtime against a built-in agent profile.
- Open a session.
- Listen to normalized events.
- Send a prompt and dispose the session.

## Run

This example is a standalone npm package that depends on the published `@acp-kit/core`. From this folder:

```bash
npm install
npm start
```

## Use as a template outside this repo

Copy this folder anywhere, then run the same two commands. No special wiring required.

> Requires GitHub Copilot CLI on `PATH`. To explore the runtime without installing any agent, use [`../mock-runtime/`](../mock-runtime/) instead.
