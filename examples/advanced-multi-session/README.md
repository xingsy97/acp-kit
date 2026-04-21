# advanced-multi-session

Shows how to create one `AcpRuntime` and run multiple `RuntimeSession`s scoped to different working directories, using `await using` for automatic cleanup.

```bash
node ./index.mjs claude . ./packages/core
```

Each session currently spawns its own agent subprocess. When the enclosing scope exits (or an exception is thrown), `await using` triggers `[Symbol.asyncDispose]` on every session and on the runtime, so all child processes are killed deterministically.

For a one-shot single-prompt run use [`quick-start`](../quick-start/) instead.
