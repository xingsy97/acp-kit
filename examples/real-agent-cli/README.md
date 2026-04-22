# Real Agent CLI

A small command-line driver that runs ACP Kit against a real ACP agent. Useful as a starting template if you are building your own CLI tool on top of ACP Kit.

## What it shows

- Selecting a built-in agent (`copilot`, `claude`, `codex`, `gemini`, `qwen`, `opencode`).
- An interactive host adapter that prompts the terminal for auth method selection and permission decisions.
- Flag overrides for non-interactive runs (CI, automation).
- Streaming normalized events to stdout.
- Final transcript snapshot.

## Run

This example is a standalone npm package that depends on the published `@acp-kit/core`. From this folder:

```bash
npm install

# interactive
npm start -- --agent copilot --prompt "Summarize this repository."

# non-interactive
npm start -- \
  --agent copilot \
  --prompt "Summarize this repository." \
  --auto-auth device \
  --auto-permission allow_once
```

## Use as a template outside this repo

Copy this folder anywhere, then:

```bash
npm install
npm start -- --agent claude --prompt "Hello"
```

## Flags

| Flag | Purpose |
| --- | --- |
| `--agent <id>` | Built-in agent id: `copilot`, `claude`, `codex`, `gemini`, `qwen`, or `opencode`. **Required.** |
| `--prompt <text>` | Prompt text to send. Defaults to a short description prompt. |
| `--cwd <path>` | Working directory for the runtime session. Defaults to the current shell `cwd`. |
| `--auto-auth <methodId>` | Pre-select an auth method without prompting. |
| `--auto-permission <allow_once\|allow_always\|deny>` | Pre-select a permission decision. |
