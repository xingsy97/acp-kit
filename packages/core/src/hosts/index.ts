/**
 * Optional reference implementations of `RuntimeHost` capabilities for hosts
 * that run on the local machine. Import from `@acp-kit/core/node` — these
 * helpers depend on `node:fs` and `node:child_process`.
 *
 * Each helper returns a partial `RuntimeHost`; spread it together with your
 * own `requestPermission` / `chooseAuthMethod` / etc. when constructing the
 * runtime.
 */
export {
  createLocalFileSystemHost,
  type LocalFileSystemHost,
  type LocalFileSystemHostOptions,
  type LocalFileSystemAccessEvent,
} from './local-fs.js';
export {
  createLocalTerminalHost,
  type LocalTerminalHost,
  type LocalTerminalHostOptions,
} from './local-terminal.js';
