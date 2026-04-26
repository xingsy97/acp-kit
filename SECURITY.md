# Security Policy

## Supported Versions

ACP Kit is in early development (`0.x`). Only the latest `0.x` minor receives security fixes.

| Version | Supported |
| --- | --- |
| latest `0.x` | Yes |
| older `0.x`  | No  |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security-sensitive reports.

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/AcpKit/acp-kit/security) of this repository.
2. Click "Report a vulnerability".
3. Provide a description, reproduction steps, and impact assessment.

We aim to acknowledge reports within 5 business days and to publish a fix or mitigation as soon as one is available.

## Scope

ACP Kit is the **runtime layer** sitting between your product and the third-party ACP agent CLI. The security boundaries follow that split:

**In scope** (report here):

- `@acp-kit/core` source code in `packages/core/`
- Build and release pipeline (`.github/workflows/`)
- Runtime behavior that could let a malicious or buggy ACP server escalate beyond the host adapters the application provides &mdash; for example: bypassing `requestPermission`, reading or writing files outside what `readTextFile` / `writeTextFile` allow, executing terminals the host did not authorize, or leaking host-supplied secrets back over the wire.
- Process / connection lifecycle bugs that allow the agent subprocess to outlive `acp.shutdown()` or to inherit unintended privileges.
- Wire normalization bugs that cause the runtime to accept a malformed `session/update` and corrupt downstream state.

**Out of scope** (please report upstream, not here):

- Vulnerabilities in [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) itself &mdash; report to that project.
- Vulnerabilities in third-party ACP agent CLIs (Copilot CLI, Claude ACP, Codex ACP, Gemini CLI, Qwen Code, OpenCode, ...) &mdash; report to the respective vendor. ACP Kit only spawns and speaks ACP to these binaries; it does not vet their behavior.
- Issues that require a malicious local user with shell access to the machine running the runtime.
- Misconfiguration of the host application (logging secrets, exposing the runtime over an unauthenticated network port, etc.).
