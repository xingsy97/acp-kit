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
- **Disk exhaustion:** Workspace creation failure such as ENOSPC must stop before launching agents and record an engine error.
- **Invalid round budgets:** Programmatic engine callers that pass maxRounds=0, negative values, fractions, NaN, Infinity, or invalid continuation budgets must not silently skip the loop or produce misleading reopened-round counts.
- **Interrupted cleanup:** Run failure plus cleanup failure must preserve both errors for diagnosis.
- **Long trace/tool output:** Trace entries and tool data are bounded to avoid runaway memory/UI output.
- **Approval-pending UI gap:** Reviewer approval that is still awaiting user choice must keep `f`, `Enter`, and `q` actionable before the final result event is emitted.
- **Crowded shortcut chrome:** Low-frequency shortcuts such as `wrap`, `trace`, and `latest` must move behind `?` without hiding current state.
- **Phase-inverted animation:** Launching must show waiting behavior, active boxing motion must start only once rounds are running, and the motion must stop again on final approval.
- **Global-install Linux startup:** A globally installed `spar` process must resolve agent startup the same way an interactive `npx` invocation does, including login-shell PATH and unscoped `npx` package fallback handling.
- **Mid-token stream splits:** Consecutive text or reasoning deltas that split a single word, including long words like `implementation` or `distribution`, must not introduce user-visible spaces into the final transcript.
- **TUI startup profiling noise:** Enabling `ACP_STARTUP_PROFILE=1` during TUI runs must not corrupt or jump the alternate-screen UI with profiler lines.
- **Startup status thrash:** Repeated startup observer phases that map to the same visible status must not spam the TUI with duplicate updates.
- **Stale startup chrome:** Once rounds are already running, delayed session ready or new session status text must not relabel an idle pane as Launching.
- **Fresh workspace reads after edits:** When files change during review or after an agent edit, the filesystem host must return current on-disk content on the next read instead of stale text.
- **Task file path confusion:** A relative task-file argument must resolve against the requested workspace root, not the shell's current directory, or launched runs can silently use inline text instead of the intended file.
- **Wrap default regression:** TUI startup must keep wrap enabled by default while still honoring explicit wrap env flags.

### Regression Assertions

- `test/engine.test.ts` asserts approval-shaped hallucinations and contradictory approval lines continue the loop.
- `test/engine.test.ts` asserts clean negated issue summaries, trailing issue-none prose, ANSI-wrapped verdicts, and resolved historical failures are accepted in one round.
- `test/engine.test.ts` asserts masked contradictions with dependency/startup crash language are rejected.
- `test/engine.test.ts` asserts `maxRounds=0`, negative, fractional, `NaN`, and `Infinity` programmatic inputs still run a safe number of rounds, and that invalid `maxApprovalContinuations` inputs fall back to the normalized base round budget.
- `test/tui-formatting.test.ts` asserts launching stays on waiting-style chrome while the boxing banner only animates during active running.
- `test/e2e-simulated.test.ts` already asserts the engine withholds final renderer results while post-approval continuation is unresolved; the TUI fix now keeps the pending approval controls visible and live during that same window.
- `packages/core/test/runtime.test.ts` asserts unscoped `npx` fallback packages can resolve to local package bins before raw `npx` startup, closing the gap seen under global Linux installs.
- `test/state.test.ts` asserts consecutive text and reasoning deltas do not inject stray spaces when short or long words are split across streaming chunks.
- `test/cli-config.test.ts` asserts TUI wrap stays enabled by default while explicit wrap env flags still override it.
- `test/runtime-role.test.ts` asserts duplicate startup phases collapse to a single user-visible status update.
- `test/tui-formatting.test.ts` asserts `q` does not enter finish mode before the run is done and that reasoning transcript sections still render with visible framing.
- `packages/core/test/hosts/local-fs.test.ts` asserts repeated reads return fresh on-disk file content after an edit, guarding against stale workspace reads during review.
- Existing engine, state, runtime-turn, runtime-role, update-check, TUI formatting, and realistic E2E tests cover startup recovery, empty output, cleanup, usage, trace bounds, timeout behavior, status rendering, and event propagation.