# ACP Kit Migration Plan

This document explains how an existing ACP-based product can adopt ACP Kit without a risky rewrite.

## Migration Strategy

Do not start with the most specialized product.

Start with adopters that already look like plain ACP clients, prove the runtime there, then move outward toward more specialized systems.

## Recommended Order

1. Shape the core using lessons from existing ACP backend implementations
2. Adopt the runtime in a thin local ACP client (for example a desktop or editor extension shell)
3. Adopt the runtime inside more specialized hosts that project ACP activity into remote transports
4. Re-evaluate whether higher-level collaboration semantics need a separate package

## Why This Order Works

Thin local ACP clients are the cleanest first adopters. They are mostly local ACP clients with product-specific UI shells.

That makes them good tests for:

- runtime lifecycle
- auth handling
- update normalization
- transcript state
- host adapter boundaries

Hosts that project ACP activity into remote rooms or control-plane events should adopt ACP Kit later, after the core contract is stable.

## Generic Mapping

For any adopter, the boundary tends to look the same.

Move into ACP Kit:

- agent spawn and connection setup
- auth flow bootstrap
- session lifecycle
- raw update normalization
- canonical turn events

Keep in the product:

- product-specific UI and state stores
- product-specific file, terminal, and permission adapters
- product-specific persistence
- product-specific control plane and remote transport layers

Expected outcome:

The product becomes a thin shell over a shared runtime.

## Phase Plan

## Phase 0: Design Only

Deliverables:

- repository documentation
- package boundaries
- API sketches
- migration map

## Phase 1: Core Runtime Skeleton

Deliverables:

- `@acp-kit/core`
- minimal agent profile system
- host adapter interfaces
- connection bootstrap and session lifecycle
- raw traffic hooks

Success check:

- can start and prompt one ACP agent in a local test harness

## Phase 2: Session Normalization

Deliverables:

- `@acp-kit/core`
- normalized runtime events
- transcript reducer
- explicit turn lifecycle helpers

Success check:

- can render a stable transcript without consuming raw ACP notifications directly

## Phase 3: First Product Adoption

Deliverables:

- integrate with one thin local ACP client
- remove duplicated runtime logic from the adopter

Success check:

- behavior parity with less ACP-specific code in the application shell

## Phase 4: Specialized Product Adoption

Deliverables:

- integrate with a more specialized host that runs ACP under a remote transport
- validate ACP Kit under remote daemon and relay conditions

Success check:

- ACP session handling is isolated and testable without remote-transport-specific state machines

## Explicit Non-Goal for Migration

Do not wait for all adopters to agree on collaboration semantics before extracting the shared ACP runtime.

That would block the useful work.

The right move is:

- extract the common ACP runtime first
- keep subagent and delegation semantics in product layers for now
- revisit a collaboration package only after the runtime seam is proven
