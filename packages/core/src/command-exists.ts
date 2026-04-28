import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export interface ResolveCommandOptions {
  pathEnv?: string;
  pathext?: string;
  platform?: NodeJS.Platform;
}

/**
 * Synchronously check whether a command name resolves on the system PATH.
 *
 * Handles:
 * - Absolute paths and paths containing slashes (checked via `existsSync`)
 * - Windows `PATHEXT` extensions (`.COM`, `.EXE`, `.BAT`, `.CMD`, …)
 * - Plain command names looked up across every `PATH` directory
 *
 * This is intentionally **synchronous** and side-effect free — no process is
 * spawned, so it completes in microseconds per call.
 */
export function isCommandOnPath(command: string): boolean {
  return resolveCommandOnPath(command) !== null;
}

/**
 * Resolve a command to the concrete file that will be launched.
 *
 * On Windows this includes PATHEXT lookup, so npm-installed shims such as
 * `copilot-language-server.cmd` are returned with their real extension instead
 * of the extensionless command name.
 */
export function resolveCommandOnPath(command: string, options: ResolveCommandOptions = {}): string | null {
  if (!command) return null;
  if (command.includes('/') || command.includes('\\') || isAbsolute(command)) {
    return existsSync(command) ? command : null;
  }

  const platform = options.platform ?? process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  const paths = pathEnv.split(pathDelimiter).filter(Boolean);
  const extensions = platform === 'win32'
    ? (options.pathext ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const base of paths) {
    const direct = join(base, command);
    const directExists = existsSync(direct);
    if (platform !== 'win32') {
      if (directExists) return direct;
      continue;
    }
    const lowerDirect = direct.toLowerCase();
    const directHasExecutableExtension = extensions.some((ext) => lowerDirect.endsWith(ext.toLowerCase()));
    if (directExists && directHasExecutableExtension) return direct;
    for (const ext of extensions) {
      const lower = direct + ext.toLowerCase();
      if (existsSync(lower)) return lower;
      const upper = direct + ext.toUpperCase();
      if (existsSync(upper)) return upper;
    }
    if (directExists) return direct;
  }
  return null;
}
