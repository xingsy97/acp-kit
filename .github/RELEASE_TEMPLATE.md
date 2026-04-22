# Release Notes Template

> Use this structure for every `@acp-kit/core` release (GitHub Release + the corresponding `CHANGELOG.md` entry). The goal is that a downstream user can answer **"what changed for me?"** and **"do I need to do anything?"** without reading commits.

---

## v0.X.Y &mdash; YYYY-MM-DD

### User-facing changes

<!--
What changed in the public API or runtime behavior?
Group as Breaking / Added / Changed / Fixed.
Keep one bullet per change. Link to source files when useful.
Do NOT paste commit messages.
-->

#### Breaking

- ...

#### Added

- ...

#### Changed

- ...

#### Fixed

- ...

### Why this matters

<!--
Two or three sentences max. Tie the change to a real downstream pain.
Example: "Before this release, products had to write their own wire-level filter to expose vendor _meta on tool events. v0.2.1 forwards _meta on every tool event so applications can render vendor-specific affordances directly."
-->

### Migration

<!--
Required if there is anything in "Breaking" above. Show a before / after diff
for each rename or signature change. If the release is purely additive, write:
> No migration needed.
-->

```diff
- ...
+ ...
```

### Compatibility

- `@agentclientprotocol/sdk`: `^0.18`
- Node.js: `>= 20.11`
- ACP spec target: vX.Y.Z

### Notes

<!-- Optional. Known issues, follow-ups, deprecations planned for the next release. -->
