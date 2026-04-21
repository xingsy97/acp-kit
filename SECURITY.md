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

1. Go to the [Security tab](https://github.com/xingsy97/acp-kit/security) of this repository.
2. Click "Report a vulnerability".
3. Provide a description, reproduction steps, and impact assessment.

We aim to acknowledge reports within 5 business days and to publish a fix or mitigation as soon as one is available.

## Scope

In scope:

- `@acp-kit/core` source code in `packages/core/`
- Build and release pipeline (`.github/workflows/`)
- Runtime behavior that could allow an ACP server to escalate beyond what the host adapters intend

Out of scope:

- Vulnerabilities in `@agentclientprotocol/sdk` itself (please report those upstream)
- Vulnerabilities in third-party ACP agents (Copilot CLI, Claude ACP, Codex ACP, etc.)
- Issues that require a malicious local user with shell access to the machine running the runtime
