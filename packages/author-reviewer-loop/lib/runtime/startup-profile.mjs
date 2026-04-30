import process from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STARTUP_PROFILE_FILE_NAME = 'startup-profile.log';

export function startupProfileFilePath({ home = os.homedir() } = {}) {
  return path.join(home, '.acp-kit', 'spar', STARTUP_PROFILE_FILE_NAME);
}

export function startupProfilingEnabled(env = process.env) {
  const value = String(env?.ACP_STARTUP_PROFILE ?? '').trim().toLowerCase();
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off');
}

export function createStartupProfileFileLogger({ filePath = startupProfileFilePath() } = {}) {
  return (line) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${line}\n`, 'utf8');
    } catch {
      // Startup profiling must never make startup fail.
    }
  };
}

export function createStartupProfiler({
  enabled = startupProfilingEnabled(),
  scope = 'startup',
  role,
  agent,
  onEvent,
  log = createStartupProfileFileLogger(),
} = {}) {
  const startedAt = Date.now();
  let lastAt = startedAt;
  const oncePhases = new Set();

  const emit = (event) => {
    const at = Number.isFinite(event?.at) ? Number(event.at) : Date.now();
    const entry = {
      scope,
      role,
      agentId: agent?.id,
      agent: agent?.displayName ?? agent?.id,
      phase: String(event?.phase || 'unknown'),
      at,
      totalMs: at - startedAt,
      sincePreviousMs: at - lastAt,
      detail: event?.detail && typeof event.detail === 'object' ? event.detail : {},
    };
    lastAt = at;
    onEvent?.(entry);
    if (enabled) log(formatStartupProfileEvent(entry));
    return entry;
  };

  return {
    enabled,
    mark(event) {
      return emit(event);
    },
    once(event) {
      const phase = String(event?.phase || 'unknown');
      if (oncePhases.has(phase)) return null;
      oncePhases.add(phase);
      return emit(event);
    },
  };
}

export function formatStartupProfileEvent(event) {
  const label = [
    'ACP_STARTUP_PROFILE',
    event.scope,
    event.role,
    event.agent,
  ].filter(Boolean).join(' ');
  const details = Object.entries(event.detail || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${formatDetailValue(value)}`)
    .join(' ');
  const timing = `+${event.totalMs}ms Δ${event.sincePreviousMs}ms`;
  return details
    ? `[${label}] ${timing} ${event.phase} ${details}`
    : `[${label}] ${timing} ${event.phase}`;
}

export function roleStatusMessageForPhase(event) {
  const phase = String(event?.phase || '');
  const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
  if (phase === 'author role open begin' || phase === 'reviewer role open begin') return 'launching...';
  if (phase === 'adapter process spawn begin') {
    if (detail.usedNpxFallback) return 'spawning via npx...';
    if (detail.launchSource === 'fallback') return 'spawning via fallback...';
    return 'spawning...';
  }
  if (phase === 'ACP connect begin' || phase === 'ACP initialize begin') return 'handshaking...';
  if (phase === 'newSession begin') return 'new session...';
  if (phase === 'role ready') return 'ready';
  return null;
}

function formatDetailValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
