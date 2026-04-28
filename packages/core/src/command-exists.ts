import { constants, existsSync, statSync } from 'node:fs';
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
 * - Windows executable/script extensions (`.COM`, `.EXE`, `.CMD`, `.BAT`, `.PS1`)
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
 * On Windows this checks the common executable/script shim extensions directly
 * instead of trusting PATHEXT alone. npm/nvm installations can expose only a
 * PowerShell shim (`.ps1`), and PATHEXT often omits `.PS1`.
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
    ? windowsCommandExtensions(options.pathext ?? process.env.PATHEXT)
    : [''];

  for (const base of paths) {
    const direct = join(base, command);
    const directExists = existsSync(direct);
    if (platform !== 'win32') {
      if (isExecutableFile(direct)) return direct;
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

function windowsCommandExtensions(pathext: string | undefined): string[] {
  const defaults = ['.COM', '.EXE', '.CMD', '.BAT', '.PS1'];
  const configured = (pathext ?? '').split(';').filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const ext of [...configured, ...defaults]) {
    const normalized = ext.startsWith('.') ? ext : `.${ext}`;
    const key = normalized.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    return Boolean(stat.mode & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH));
  } catch {
    return false;
  }
}
