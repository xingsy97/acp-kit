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
packages/core/   @acp-kit/core source, tests, build output (the only published package)
examples/        runnable demos
docs/            architecture and design notes
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
- Tests live next to the package they cover: `packages/core/test/`.
- Prefer testing behavior at the public API boundary (`createRuntime`, `RuntimeSession`) over testing internal helpers in isolation.

## Release

Releases are cut from `main` by maintainers:

1. Bump `packages/core/package.json` `version`.
2. Add a section to `CHANGELOG.md`.
3. Merge the bump PR.
4. Tag `vX.Y.Z` and push the tag.
5. The `release` GitHub Actions workflow publishes to npm with provenance.

Contributors do not need to publish locally.

## Reporting Bugs

Please use [GitHub Issues](https://github.com/xingsy97/acp-kit/issues). Include:

- ACP Kit version
- `@agentclientprotocol/sdk` version
- Node.js version and OS
- Minimal reproduction (ideally based on `examples/runtime-demo.mjs`)

## Security

For security-sensitive reports, please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
