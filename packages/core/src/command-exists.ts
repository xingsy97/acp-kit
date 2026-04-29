import { createHash } from 'node:crypto';
import { constants, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

export interface ResolveCommandOptions {
  pathEnv?: string;
  pathext?: string;
  platform?: NodeJS.Platform;
  cacheTtlMs?: number;
  cacheFile?: string;
  disableCache?: boolean;
  now?: number;
}

interface CommandResolutionCacheEntry {
  checkedAt: number;
  resolved: string | null;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_FILE = join(homedir(), '.acp-kit-command-cache.json');
const PERSISTED_CACHE_VERSION = 1;
const MAX_PERSISTED_ENTRIES = 512;
const memoryCache = new Map<string, CommandResolutionCacheEntry>();
const loadedPersistentFiles = new Set<string>();
const persistentStores = new Map<string, Map<string, CommandResolutionCacheEntry>>();

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
  const now = options.now ?? Date.now();
  if (!options.disableCache) {
    const cached = getCachedResolution(command, options, now);
    if (cached !== undefined) return cached;
  }

  const resolved = resolveCommandOnPathUncached(command, options);
  if (!options.disableCache) {
    setCachedResolution(command, options, now, resolved);
  }
  return resolved;
}

export function clearCommandResolutionCache(options: { cacheFile?: string } = {}): void {
  memoryCache.clear();
  const cacheFile = normalizeCacheFile(options.cacheFile);
  loadedPersistentFiles.delete(cacheFile);
  persistentStores.delete(cacheFile);
  try {
    unlinkSync(cacheFile);
  } catch {
    /* ignore missing cache files */
  }
}

function resolveCommandOnPathUncached(command: string, options: ResolveCommandOptions = {}): string | null {
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

function getCachedResolution(command: string, options: ResolveCommandOptions, now: number): string | null | undefined {
  const ttlMs = normalizeCacheTtl(options.cacheTtlMs);
  const cacheKey = buildCacheKey(command, options);
  const inMemory = memoryCache.get(cacheKey);
  if (inMemory && now - inMemory.checkedAt <= ttlMs) {
    if (cachedResolutionStillExists(inMemory.resolved)) {
      return inMemory.resolved;
    }
    memoryCache.delete(cacheKey);
  }

  const store = loadPersistentStore(normalizeCacheFile(options.cacheFile));
  const persisted = store.get(cacheKey);
  if (!persisted || now - persisted.checkedAt > ttlMs) {
    if (persisted) {
      store.delete(cacheKey);
      persistStore(normalizeCacheFile(options.cacheFile), store);
    }
    return undefined;
  }

  if (!cachedResolutionStillExists(persisted.resolved)) {
    store.delete(cacheKey);
    persistStore(normalizeCacheFile(options.cacheFile), store);
    return undefined;
  }

  memoryCache.set(cacheKey, persisted);
  return persisted.resolved;
}

function setCachedResolution(
  command: string,
  options: ResolveCommandOptions,
  now: number,
  resolved: string | null,
): void {
  const cacheKey = buildCacheKey(command, options);
  const entry: CommandResolutionCacheEntry = { checkedAt: now, resolved };
  memoryCache.set(cacheKey, entry);
  const cacheFile = normalizeCacheFile(options.cacheFile);
  const store = loadPersistentStore(cacheFile);
  store.set(cacheKey, entry);
  trimPersistentStore(store);
  persistStore(cacheFile, store);
}

function buildCacheKey(command: string, options: ResolveCommandOptions): string {
  const platform = options.platform ?? process.platform;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const pathext = platform === 'win32' ? (options.pathext ?? process.env.PATHEXT ?? '') : '';
  const envHash = createHash('sha1')
    .update(platform)
    .update('\0')
    .update(pathEnv)
    .update('\0')
    .update(pathext)
    .digest('hex');
  const normalizedCommand = platform === 'win32' ? command.toLowerCase() : command;
  return `${platform}:${envHash}:${normalizedCommand}`;
}

function normalizeCacheTtl(cacheTtlMs: number | undefined): number {
  return Number.isFinite(cacheTtlMs) && Number(cacheTtlMs) >= 0
    ? Number(cacheTtlMs)
    : DEFAULT_CACHE_TTL_MS;
}

function normalizeCacheFile(cacheFile: string | undefined): string {
  return cacheFile || DEFAULT_CACHE_FILE;
}

function loadPersistentStore(cacheFile: string): Map<string, CommandResolutionCacheEntry> {
  if (!loadedPersistentFiles.has(cacheFile)) {
    loadedPersistentFiles.add(cacheFile);
    persistentStores.set(cacheFile, readPersistentStore(cacheFile));
  }
  return persistentStores.get(cacheFile) ?? new Map<string, CommandResolutionCacheEntry>();
}

function readPersistentStore(cacheFile: string): Map<string, CommandResolutionCacheEntry> {
  try {
    const raw = readFileSync(cacheFile, 'utf8');
    const parsed = JSON.parse(raw) as {
      version?: number;
      entries?: Record<string, CommandResolutionCacheEntry>;
    };
    if (parsed?.version !== PERSISTED_CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
      return new Map<string, CommandResolutionCacheEntry>();
    }
    const entries = Object.entries(parsed.entries)
      .filter(([, value]) =>
        value
        && typeof value === 'object'
        && typeof value.checkedAt === 'number'
        && ('resolved' in value),
      );
    return new Map(entries);
  } catch {
    return new Map<string, CommandResolutionCacheEntry>();
  }
}

function trimPersistentStore(store: Map<string, CommandResolutionCacheEntry>): void {
  if (store.size <= MAX_PERSISTED_ENTRIES) return;
  const oldestEntries = [...store.entries()]
    .sort((left, right) => left[1].checkedAt - right[1].checkedAt)
    .slice(0, store.size - MAX_PERSISTED_ENTRIES);
  for (const [key] of oldestEntries) {
    store.delete(key);
  }
}

function persistStore(cacheFile: string, store: Map<string, CommandResolutionCacheEntry>): void {
  try {
    writeFileSync(cacheFile, JSON.stringify({
      version: PERSISTED_CACHE_VERSION,
      entries: Object.fromEntries(store.entries()),
    }), 'utf8');
  } catch {
    /* cache writes are best-effort */
  }
}

function cachedResolutionStillExists(resolved: string | null): boolean {
  return resolved === null || existsSync(resolved);
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
