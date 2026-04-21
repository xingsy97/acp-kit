# Pair Programming

Two ACP agents collaborating on the same working directory:

- **AUTHOR** &mdash; Claude Code (`claude` profile, `haiku` model). Writes / modifies files via the agent's filesystem tools.
- **REVIEWER** &mdash; Codex (`codex` profile, `gpt-5.4` model). Reads the files back via its own filesystem tools and replies `APPROVED` or a numbered list of issues.

The script loops until `APPROVED` (or `MAX_ROUNDS` is hit). The deliverable is the working tree, not pasted code.

## What it shows

- `authorSettings` / `reviewerSettings` objects at the top of `index.mjs` &mdash; swap profile or model in one place.
- Two `createAcpRuntime` instances (one per agent process) hosting one session each, both pointed at the same `cwd`.
- `session.setModel(...)` &mdash; per-session model selection via ACP `session/set_model`.
- `session.on({ messageDelta, toolStart, toolEnd, turnCompleted, turnFailed })` &mdash; handler-map dispatch over normalized `RuntimeSessionEvent`s.
- `await session.prompt(text)` returns `Promise<PromptResult>`; the multi-turn loop is plain user code.

## Run

```bash
npm install
npm start                                            # cwd=., default fizzbuzz task
npm start -- g:\demo-fizzbuzz                        # explicit cwd
npm start -- g:\demo-fizzbuzz "Write a CLI that lowercases stdin"
```

> Requires both `claude` and `codex` ACP CLIs on `PATH`, and each must expose the configured model id (`haiku` / `gpt-5.4`) via ACP `session/set_model`. To use different agents or models, edit `authorSettings` / `reviewerSettings` at the top of `index.mjs`.

## Output

Streamed assistant text appears inline; tool calls and turn outcomes appear as bracketed markers:

```
Round 1 \u00b7 AUTHOR
  [tool #1 start] Creating fizzbuzz.mjs
  [tool #1 completed]
  ...
  (turn done: end_turn)

Round 1 \u00b7 REVIEWER
  [tool #1 start] Viewing fizzbuzz.mjs
  [tool #1 completed]
APPROVED
  (turn done: end_turn)

\u2713 Approved. Files under g:\demo-fizzbuzz.
```

Exit code is `0` on approval, `1` if `MAX_ROUNDS` is hit without approval. The working tree is left in place for inspection.
