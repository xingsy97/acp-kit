/**
 * Node-specific entry point for `@acp-kit/core`.
 *
 *   import { nodeChildProcessTransport } from '@acp-kit/core/node';
 *
 * Importing this module pulls in `node:child_process`, `node:fs`, and
 * `node:stream`. Browser / Webview consumers should import from
 * `@acp-kit/core` only and provide their own `transport` to `createAcpRuntime`.
 */
export {
  nodeChildProcessTransport,
  createSdkConnectionFactory,
  createLoginShellSpawnProcess,
  defaultSpawnProcess,
  type NodeChildProcessTransportOptions,
  type SpawnOptions,
  type SpawnedProcess,
  type SpawnProcess,
  type AcpConnectionFactory,
} from './transports/node.js';

export * from './hosts/index.js';
