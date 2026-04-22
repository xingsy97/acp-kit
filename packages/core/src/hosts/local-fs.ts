import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

import type { RuntimeHost } from '../host.js';

export interface LocalFileSystemAccessEvent {
  op: 'read' | 'write';
  /** Resolved absolute path on disk. */
  path: string;
  /** Path relative to the sandbox root. */
  relativePath: string;
}

export interface LocalFileSystemHostOptions {
  /** Absolute path to the sandbox root. All accesses must resolve under this directory. */
  root: string;
  /**
   * Called after each successful IO. Use this to wire your own logging/audit;
   * the helper itself does not log. Errors thrown here propagate to the caller.
   */
  onAccess?: (event: LocalFileSystemAccessEvent) => void;
  /**
   * If true, allow paths whose realpath escapes `root` via symlinks. Defaults
   * to `false` — symlinked-out paths are rejected the same way as `..` escapes.
   */
  followSymlinksOutsideRoot?: boolean;
}

export type LocalFileSystemHost = Required<Pick<RuntimeHost, 'readTextFile' | 'writeTextFile'>>;

/**
 * Build a `RuntimeHost` partial that implements ACP `fs/read_text_file` and
 * `fs/write_text_file` against the local filesystem, sandboxed to a single
 * `root` directory.
 *
 * Compose with your own permission/terminal handlers:
 *
 * ```ts
 * const fsHost = createLocalFileSystemHost({ root: workingDirectory });
 * const runtime = createAcpRuntime({
 *   profile,
 *   host: { ...fsHost, requestPermission: myPrompt },
 * });
 * ```
 *
 * Security model:
 * - `root` must be an absolute path; relative roots are rejected.
 * - Every requested path is resolved against `root`, then `realpath`-checked
 *   to ensure it still lives under `root`. `..` traversal and (by default)
 *   symlinks pointing outside the sandbox throw before any IO happens.
 *
 * Not appropriate when:
 * - Your host serves multiple workspace roots (e.g. a VS Code multi-root window) —
 *   write a host that picks the right root per request instead.
 * - The agent runs on a different machine than the files (use a transport
 *   that proxies `fs/*` to the real client).
 */
export function createLocalFileSystemHost(options: LocalFileSystemHostOptions): LocalFileSystemHost {
  const { root, onAccess, followSymlinksOutsideRoot = false } = options;
  if (!root || typeof root !== 'string') {
    throw new TypeError('createLocalFileSystemHost: `root` is required');
  }
  if (!isAbsolute(root)) {
    throw new TypeError(`createLocalFileSystemHost: \`root\` must be an absolute path (got ${root})`);
  }
  // Resolve the root through `realpath` so that comparisons (e.g. on Windows
  // where `os.tmpdir()` may return an 8.3 short path like `RUNNER~1`) work
  // after we `realpath` children to their canonical long form. Falls back to
  // the lexical resolve when the root does not exist yet.
  const lexicalRoot = resolve(root);
  let cachedRealRoot: string | null = null;
  try {
    cachedRealRoot = realpathSync(lexicalRoot);
  } catch {
    /* root does not exist yet; lexical resolve is fine */
  }

  // The async `fs.realpath` on Windows can return a different canonicalization
  // than the sync `realpathSync` (e.g. 8.3 short-name expansion). To keep the
  // post-realpath comparison apples-to-apples, lazily resolve the root through
  // the async API on first use and cache it.
  const getRealRoot = async (): Promise<string> => {
    if (cachedRealRoot != null) {
      try {
        cachedRealRoot = await realpath(cachedRealRoot);
      } catch {
        /* keep the sync/lexical value */
      }
      return cachedRealRoot;
    }
    try {
      cachedRealRoot = await realpath(lexicalRoot);
    } catch {
      cachedRealRoot = lexicalRoot;
    }
    return cachedRealRoot;
  };

  const resolveWithinRoot = async (requested: string): Promise<string> => {
    if (typeof requested !== 'string' || requested.length === 0) {
      throw new Error('Path must be a non-empty string');
    }
    const realRoot = await getRealRoot();
    const resolved = resolve(realRoot, requested);
    assertUnderRoot(realRoot, resolved, requested);
    if (!followSymlinksOutsideRoot) {
      // realpath the deepest existing ancestor; non-existent leaf is fine for write.
      try {
        const real = await realpath(resolved);
        assertUnderRoot(realRoot, real, requested);
      } catch (err) {
        // ENOENT on the leaf is expected for fresh writes — walk up.
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
        const parent = dirname(resolved);
        if (parent !== resolved) {
          try {
            const realParent = await realpath(parent);
            const rebuilt = resolve(realParent, requested.split(/[\\/]/).pop() || '');
            assertUnderRoot(realRoot, rebuilt, requested);
          } catch (parentErr) {
            if ((parentErr as NodeJS.ErrnoException)?.code !== 'ENOENT') throw parentErr;
            // Parent doesn't exist either; lexical check above already passed.
          }
        }
      }
    }
    return resolved;
  };

  const emit = (op: 'read' | 'write', resolvedPath: string) => {
    if (!onAccess) return;
    const root = cachedRealRoot ?? lexicalRoot;
    onAccess({
      op,
      path: resolvedPath,
      relativePath: relative(root, resolvedPath),
    });
  };

  return {
    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      const filePath = await resolveWithinRoot(params.path);
      let content = await readFile(filePath, 'utf-8');
      if (params.line != null || params.limit != null) {
        const lines = content.split('\n');
        const start = (params.line ?? 1) - 1;
        const end = params.limit != null ? start + params.limit : lines.length;
        content = lines.slice(Math.max(0, start), end).join('\n');
      }
      emit('read', filePath);
      return { content };
    },

    async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
      const filePath = await resolveWithinRoot(params.path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, params.content, 'utf-8');
      emit('write', filePath);
      return {};
    },
  };
}

function assertUnderRoot(root: string, candidate: string, requested: string): void {
  const r = canonicalizeForCompare(root);
  const c = canonicalizeForCompare(candidate);
  if (c === r) return;
  const sep = process.platform === 'win32' ? '\\' : '/';
  if (c.startsWith(r.endsWith(sep) ? r : r + sep)) return;
  throw new Error(`Path escapes sandbox root: ${requested}`);
}

/**
 * Normalize a path for safe equality / startsWith comparison across the
 * platform-specific oddities `path.relative` cannot smooth over by itself
 * (Windows `\\?\` long-path prefix and case-insensitive volumes).
 */
function canonicalizeForCompare(p: string): string {
  let out = p;
  if (process.platform === 'win32') {
    if (out.startsWith('\\\\?\\')) out = out.slice(4);
    out = out.toLowerCase();
  }
  return out;
}
