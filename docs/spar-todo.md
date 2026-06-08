# Spar Practical TODO

This is the short-list of practical Spar improvements that should be prioritized after the real-workspace enforcement work.

## Next

- No outstanding items. The previous list (spar doctor, real-disk change detection, real-workspace adapter registry, failure diagnostic bundle, README real-workspace docs, and the `SPAR_REAL_AGENT_E2E` smoke tests) is implemented.

## Notes

- Keep CI healthy: fix regressions immediately when the `release` or `main` workflows turn red. The release workflow is per-package (`core-v*` / `spar-v*`), publishes only the matching package, and is idempotent on re-runs, which removes the old failure mode where a single-package change red-lit a coupled release.
- `SPAR_REAL_AGENT_E2E=1` runs the gated real-agent smoke tests (`packages/author-reviewer-loop/test/e2e-real-agent-smoke.test.ts`); they are skipped by default so the fake-ACP suite stays fast. See `CONTRIBUTING.md`.
- Reviewer prompts should treat the AUTHOR reply as a report to investigate, not as evidence. The reviewer should double-check actual files and use git only when the workspace is a git repository.
- Do not add a fresh/no-recovery mode for now.
