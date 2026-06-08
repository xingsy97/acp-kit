# Contributing to ACP Kit

Thanks for your interest in contributing.

## Development Setup

```bash
npm install
npm run build
npm test
```

Requirements:

- Node.js >= 18
- npm 9+

## Project Layout

```
packages/core/                   @acp-kit/core source, tests, and build output
packages/author-reviewer-loop/   @acp-kit/spar CLI (Spar), source and tests
examples/                        runnable demos
docs/                            architecture and design notes
```

## Workflow

1. Open an issue first for non-trivial changes so the design can be discussed before implementation.
2. Create a topic branch off `main`.
3. Make focused commits. Keep unrelated refactors out of the same PR.
4. Add or update tests for any logic change. Run `npm test` locally.
5. Run `npm run build` to confirm the TypeScript build is clean.
6. Open a PR. CI must be green before review.

## Coding Style

- Keep the public API of `@acp-kit/core` boring and explicit. Prefer adding host adapter callbacks over hidden global behavior.
- Internal modules live as separate files under `packages/core/src/`. New responsibilities should follow the existing one-file-per-concern split (`profiles.ts`, `host.ts`, `runtime.ts`, `session.ts`, `events.ts`, `normalize.ts`, `transcript.ts`).
- Do not introduce additional public packages without first updating [docs/package-plan.md](docs/package-plan.md). The split criteria are documented there.
- Keep dependencies minimal. New runtime dependencies require justification in the PR description.

## Tests

- Unit tests use [Vitest](https://vitest.dev/).
- Tests live next to the package they cover: `packages/core/test/` and `packages/author-reviewer-loop/test/`.
- Prefer testing behavior at the public API boundary (`createRuntime`, `RuntimeSession`) over testing internal helpers in isolation.

### Real-agent smoke tests

`packages/author-reviewer-loop/test/e2e-real-agent-smoke.test.ts` drives the real Spar CLI against real ACP agents. It is gated behind `SPAR_REAL_AGENT_E2E=1` and **skipped by default**, so ordinary `npm test` (and CI) stays fast on the fake-ACP suite. Run it manually before a Spar release once the relevant agents are installed:

```bash
npm run build
SPAR_REAL_AGENT_E2E=1 npm test                                    # default agent: codex
SPAR_REAL_AGENT_E2E=1 SPAR_REAL_AGENT_E2E_AGENTS=codex,claude npm test
```

Optional knobs: `SPAR_REAL_AGENT_E2E_TIMEOUT_MS` (default 300000) and `SPAR_REAL_AGENT_E2E_MAX_ROUNDS` (default 3).

## Release

Releases are cut from `main` by maintainers. Each package is released independently with its own tag:

1. Bump the version of the package you are releasing (`packages/core/package.json` for core, `packages/author-reviewer-loop/package.json` for spar).
2. Add a section to that package's changelog (`CHANGELOG.md` for core, `packages/author-reviewer-loop/CHANGELOG.md` for spar).
3. Merge the bump.
4. Tag the commit: `core-vX.Y.Z` to publish `@acp-kit/core`, or `spar-vX.Y.Z` to publish `@acp-kit/spar`. Push the tag.
5. The `release` GitHub Actions workflow publishes only the matching package to npm with provenance. If a spar release needs new core functionality, publish `core-v...` first.

See [`.github/skills/release-prep/SKILL.md`](.github/skills/release-prep/SKILL.md) for the full checklist. Contributors do not need to publish locally.

## Reporting Bugs

Please use [GitHub Issues](https://github.com/AcpKit/acp-kit/issues). Include:

- ACP Kit version
- `@agentclientprotocol/sdk` version
- Node.js version and OS
- Minimal reproduction (ideally based on `examples/runtime-demo.mjs`)

## Security

For security-sensitive reports, please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
