# ACP SDK vs ACP Kit

This document explains the difference between the official ACP SDK and ACP Kit in the simplest possible terms.

## Short Answer

`@agentclientprotocol/sdk` solves the ACP protocol layer.

ACP Kit would solve the shared product runtime layer that sits above the protocol.

They are complementary, not competing.

More concretely:

- the SDK helps you send ACP messages over an existing connection
- ACP Kit helps you obtain, manage, and productize that connection

## Why ACP Kit?

ACP already solves one important problem.

It standardizes how agents and applications talk to each other, much like LSP standardized how editors and language tools communicate.

That is a big win, but it still leaves another layer unsolved.

Even when two systems both speak ACP, application developers still need to build a lot of repeated runtime code around the protocol:

- start the right agent process
- handle platform-specific launch quirks
- recover from startup and auth failures
- wire permission callbacks into product UI
- normalize raw `session/update` notifications into message, reasoning, tool, and usage state
- decide when a turn is actually complete

This is similar to what happened around LSP.

LSP standardized the wire protocol, but editor authors still benefited from shared language-client frameworks that handled server lifecycle, capability wiring, state synchronization, and other repeated client logic.

ACP Kit is meant to play that same role for ACP-based products.

It is not a new protocol.

It is the reusable runtime layer above the protocol.

## The Fast Analogy

- ACP is like LSP: the standard protocol between two sides
- `@agentclientprotocol/sdk` is like the low-level protocol library
- ACP Kit is like the shared client/runtime layer that product teams use so they do not each rebuild lifecycle, state, and integration logic from scratch

In other words:

- ACP answers: "How do these systems communicate?"
- ACP Kit answers: "How do I build a real product on top of that communication model without rewriting the same runtime every time?"

## The Easy Mental Model

Think of the official SDK as a network driver.

It gives you the low-level ability to connect, send requests, receive notifications, and implement protocol callbacks.

Think of ACP Kit as the reusable engine that applications build on top of that driver.

It gives you a stable way to launch agents, recover from real-world failures, normalize streaming updates, manage turns, and expose events that UI or remote orchestration systems can consume directly.

## What Happens If You Only Use the Official SDK?

If you only use `@agentclientprotocol/sdk`, nothing automatically launches an agent for you.

The SDK does not mean "there is now a Copilot process" or "there is now a Claude process".

It means you have the client-side protocol library needed to talk to an ACP server once you already have a transport to that server.

So if your application calls `initialize`, one of two things must already be true:

1. your application has spawned a local ACP-speaking agent process and connected to its `stdin` and `stdout`
2. your application has connected to some existing ACP server over another transport such as a socket, port, or remote bridge

If neither of those is true, there is nowhere for `initialize` to go.

The same is true for `newSession`.

`newSession` creates a session on an already connected ACP server.

It does not locate the server, start the server, or decide which agent implementation should be serving that session.

## How the SDK Knows Who It Is Talking To

The SDK does not identify the other side by PID.

It identifies the other side by transport.

That transport is whatever the application gives it when it creates the client connection.

In a local CLI scenario, the transport is usually:

- child process `stdin`
- child process `stdout`
- NDJSON framing on top of those streams

That is exactly what the current `acp-kit` does.

The runtime first launches the selected agent CLI, then wraps the child process streams in `ndJsonStream`, then creates `ClientSideConnection` on top of that stream pair.

At that point, the SDK is "talking to Copilot" or "talking to Claude" because the transport is physically connected to that specific ACP server process.

If a different product used a local TCP port or a remote URL bridge instead, the SDK would be talking over that transport instead.

So the protocol SDK knows the peer because the application or runtime already connected it to the peer.

The SDK itself does not perform agent discovery.

## Why Spawning the CLI Still Matters

For CLI-backed agents such as Copilot, Claude, or Codex, the CLI process is usually the ACP server.

That means a product typically still needs logic for:

- selecting the right CLI
- finding the right command path or package
- handling Windows and shell-specific launch behavior
- collecting startup errors and exit details
- deciding what to do when auth is required before `newSession` succeeds

That is why `initialize` and `newSession` are not enough by themselves to build a product.

They solve the protocol conversation after the connection exists.

ACP Kit exists to solve the repeated application work needed before and around that conversation.

## What the Official SDK Already Does Well

The official SDK is the correct place for:

- ACP method and schema definitions
- `ClientSideConnection`
- JSON-RPC framing and stream handling
- typed request and notification payloads
- protocol method invocation such as `initialize`, `session/new`, `session/prompt`, and `session/cancel`

That is exactly what a protocol SDK should do.

## What the Official SDK Intentionally Does Not Solve

The official SDK does not try to be a full application runtime.

It does not define:

- how to spawn each ACP agent reliably across platforms
- how to recover from startup failures or timeouts
- how to orchestrate auth flows in product-friendly ways
- how to normalize raw `session/update` streams into a stable chat or transcript model
- how to determine turn completion in a product-safe way
- how to expose a canonical event model for tool lifecycle, reasoning, or usage updates
- how to project ACP updates into product-specific shells such as VS Code, Tauri, Web PubSub, or a mobile daemon

Those are the problems ACP Kit is meant to solve.

## Same Goal, Different Code

The easiest way to understand the difference is to compare the code required to achieve the same goal.

Assume the application wants to do exactly this:

1. start one ACP agent session
2. send one prompt
3. stream assistant text to the UI
4. stream reasoning to the UI
5. track tool start and tool completion
6. know when the turn is actually finished

That is one product goal.

The difference is how much code you must write yourself to get there.

## Same Goal with the Official SDK Only

With `@agentclientprotocol/sdk`, you can absolutely do it.

But you still need to build the runtime layer yourself:

```ts
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

const child = spawnAgentProcess(command, args, cwd)
const stream = ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
)

let currentMessage = ''
let currentReasoning = ''
const toolCalls = new Map()

const client = {
  async sessionUpdate(notification) {
    const update = notification.update

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = update.content?.text || ''
        currentMessage += text
        ui.appendAssistantDelta(text)
        break
      }
      case 'agent_thought_chunk': {
        const text = update.content?.text || ''
        currentReasoning += text
        ui.appendReasoningDelta(text)
        break
      }
      case 'tool_call': {
        toolCalls.set(update.toolCallId, {
          name: update.toolName || update.title,
          status: update.status || 'pending',
        })
        ui.showToolStarted(update.toolCallId, toolCalls.get(update.toolCallId))
        break
      }
      case 'tool_call_update': {
        const tool = toolCalls.get(update.toolCallId)
        if (tool) {
          tool.status = update.status || tool.status
        }
        ui.showToolUpdated(update.toolCallId, tool)
        break
      }
      case 'current_mode_update': {
        ui.updateMode(update.currentModeId)
        break
      }
      case 'available_commands_update': {
        ui.updateCommands(update.availableCommands || [])
        break
      }
    }
  },

  async requestPermission(request) {
    const optionId = await ui.askUserForPermission(request)
    return { outcome: { outcome: 'selected', optionId } }
  },
}

const connection = new ClientSideConnection(() => client, stream)

const initResponse = await connection.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientInfo: { name: 'my-app', version: '0.1.0' },
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
})

const session = await connection.newSession({ cwd, mcpServers: [] })

await connection.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: 'text', text: userPrompt }],
})

// You still need your own rules for:
// - startup retry
// - auth required errors
// - Windows spawn quirks
// - transcript aggregation
// - deciding when the turn is complete
// - flushing the last buffered assistant/reasoning chunk
```

The important point is not that this code is wrong.

The important point is that the official SDK stops at the protocol boundary, so the application still owns the runtime boundary.

## Same Goal with ACP Kit

With ACP Kit, the product is still doing the same thing.

But the repeated runtime work has already been pulled into a shared layer:

```ts
import { createAcpRuntime, ClaudeCode } from '@acp-kit/core'

await using acp = createAcpRuntime({
  agent: ClaudeCode,
  host: {
    requestPermission: async (request) => ui.askPermission(request),
  },
})

await using session = await acp.newSession({ cwd })

session.on('message.delta', (event) => {
  ui.appendAssistantDelta(event.delta)
})

session.on('reasoning.delta', (event) => {
  ui.appendReasoningDelta(event.delta)
})

session.on('tool.start', (event) => {
  ui.showToolStarted(event.toolCallId, event)
})

session.on('tool.end', (event) => {
  ui.showToolCompleted(event.toolCallId, event)
})

session.on('turn.completed', () => {
  ui.finishTurn()
})

await session.prompt(userPrompt)
```

Same goal.

Less product-specific runtime code.

The application mostly subscribes to stable events instead of rebuilding its own ACP Kit.

## What ACP Kit Removed from the Application Code

To accomplish the exact same goal, ACP Kit absorbs the code that applications otherwise keep rewriting:

- spawning agent processes with profile-specific defaults
- establishing ACP connections on top of the official SDK
- handling auth-required retries for `session/new`
- mapping raw `session/update` notifications into stable events
- tracking assistant and reasoning stream buffers
- tracking tool lifecycle state
- exposing explicit turn completion instead of forcing each app to infer it differently

That is the real difference.

The official SDK is still underneath.

ACP Kit just takes the repeated runtime code out of the application and puts it into a shared layer.

## Layer Boundary Table

| Question | Official SDK | ACP Kit |
| --- | --- | --- |
| How do I send ACP requests and receive notifications? | Yes | Built on top |
| How do I spawn Copilot vs Claude vs Codex reliably? | No | Yes |
| How do I model agent-specific launch quirks? | No | Yes |
| How do I retry `initialize` or `session/new` safely? | No | Yes |
| How do I normalize `session/update` into transcript events? | No | Yes |
| How do I expose a turn lifecycle to apps? | No | Yes |
| How do I render chat UI? | No | No |
| How do I sync remote rooms or relay streams? | No | No |

## Why This Extra Layer Matters

Without ACP Kit, every ACP-powered application keeps rebuilding the same runtime logic.

That usually leads to:

- duplicated startup and auth code
- duplicated update parsers
- different turn-completion behavior across apps
- product-specific fixes that never flow back into a shared abstraction

ACP Kit exists to stop that duplication at the right layer.

## What ACP Kit Should Not Do

To stay useful, ACP Kit should not absorb everything.

It should not become:

- a UI toolkit
- a persistence framework
- a remote sync system
- a team workflow protocol
- a subagent or delegation control plane

Those are real problems, but they belong above this layer.

## Decision Rule

If the problem is about ACP message transport or typed RPC contracts, it belongs in the official SDK.

If the problem is about turning ACP into a stable application runtime that multiple products can reuse, it belongs in ACP Kit.