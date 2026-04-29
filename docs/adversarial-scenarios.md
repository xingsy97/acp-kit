# Adversarial Scenario Analysis

## Author-Reviewer Loop Verdict Hardening

This pass focused on user-visible loop termination and recovery behavior in `@acp-kit/spar`.

### Failure Cases Covered

- **Malformed reviewer approval:** Reviewer text that mentions `APPROVED` outside the first non-empty line must not end the loop.
- **Contradictory approval:** `APPROVED` followed by failure, missing-work, timeout, crash, dependency, or restart-recovery issues must be treated as feedback.
- **Clean approval notes:** `APPROVED` followed by realistic summaries such as `No remaining issues`, `Problems: none`, or `Issues: none. Everything looks solid.` must not cause unnecessary extra rounds.
- **Masked contradictions:** Clean-looking notes with `but/however` plus failure language must still be rejected.
- **Terminal-formatted verdicts:** ANSI color escapes and zero-width characters around verdicts must be stripped before interpretation.
- **Historical failures:** Reviewer notes that explicitly say a previous failure is now fixed and verified must not be treated as current rejection feedback.
- **Empty reviewer output:** Blank reviewer replies must become explicit recovery feedback instead of accidental approval.
- **Contradictory reviewer guidance:** Later feedback must be fed into the next author round without losing prior loop state.
- **Startup and dependency failures:** Role startup failures and model/dependency conflicts must surface while closing any role that started.
- **Disk exhaustion:** Workspace creation failure such as `ENOSPC` must stop before launching agents and record an engine error.
- **Interrupted cleanup:** Run failure plus cleanup failure must preserve both errors for diagnosis.
- **Long trace/tool output:** Trace entries and tool data are bounded to avoid runaway memory/UI output.

### Regression Assertions

- `test/engine.test.ts` asserts approval-shaped hallucinations and contradictory approval lines continue the loop.
- `test/engine.test.ts` asserts clean negated issue summaries, trailing issue-none prose, ANSI-wrapped verdicts, and resolved historical failures are accepted in one round.
- `test/engine.test.ts` now asserts masked contradictions with dependency/startup crash language are rejected.
- Existing engine, state, runtime-turn, and realistic E2E tests cover startup recovery, empty output, cleanup, usage, trace bounds, and event propagation.
- Reviewed changed runtime, role startup, TUI startup/status, CLI update-check, and CLI entry-point diffs; their existing focused tests cover startup status mapping, cleanup, terminal cwd confinement, timeout/update-check behavior, and TUI formatting/status rendering.
