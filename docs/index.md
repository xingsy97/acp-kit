---
layout: home

title: ACP Kit

description: ACP Kit is a runtime for building applications on top of the Agent Client Protocol.

hero:
  name: ACP Kit
  text: Ship ACP agents, not agent plumbing.
  tagline: One runtime to launch any ACP agent, including Copilot, Claude, and Codex. Process lifecycle, auth retries, and streaming events handled.
  image:
    src: /logo.svg
    alt: ACP Kit logo
---

<AgentMacTerminal />

## Why ACP Kit

<div class="feature-grid">
  <article class="feature-card">
    <h3>A runtime, not just types</h3>
    <p>The official ACP SDK gives you protocol types. ACP Kit gives you the runtime around them &mdash; spawning the agent, completing the handshake, retrying auth, and keeping the connection healthy.</p>
  </article>
  <article class="feature-card">
    <h3>Streaming, the way you want it</h3>
    <p>Subscribe to normalized events for application code, or iterate the raw protocol stream for protocol-faithful integrations. Same session, two views, no glue code.</p>
  </article>
  <article class="feature-card">
    <h3>Only the capabilities you opt into</h3>
    <p>File access, terminals, permission prompts &mdash; advertise only what your product can actually deliver. ACP Kit negotiates the right capability set with the agent automatically.</p>
  </article>
  <article class="feature-card">
    <h3>Failures you can act on</h3>
    <p>Spawn errors, auth errors, and protocol errors arrive with the context you need to tell <em>misconfigured</em> from <em>missing</em> &mdash; no log spelunking required.</p>
  </article>
</div>

## Examples

- [quick-start](https://github.com/xingsy97/acp-kit/tree/main/examples/quick-start)
- [pair-programming](https://github.com/xingsy97/acp-kit/tree/main/examples/pair-programming)
- [mock-runtime](https://github.com/xingsy97/acp-kit/tree/main/examples/mock-runtime)
- [real-agent-cli](https://github.com/xingsy97/acp-kit/tree/main/examples/real-agent-cli)
