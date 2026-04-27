import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

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
  if (!command) return false;
  if (command.includes('/') || command.includes('\\') || isAbsolute(command)) {
    return existsSync(command);
  }

  const pathEnv = process.env.PATH || '';
  const paths = pathEnv.split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const base of paths) {
    const direct = join(base, command);
    if (existsSync(direct)) return true;
    for (const ext of extensions) {
      if (existsSync(direct + ext.toLowerCase()) || existsSync(direct + ext.toUpperCase())) return true;
    }
  }
  return false;
}
