import process from 'node:process';

export function startupProfilingEnabled(env = process.env) {
  const value = String(env?.ACP_STARTUP_PROFILE ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function createStartupProfiler({
  enabled = startupProfilingEnabled(),
  scope = 'startup',
  role,
  agent,
  onEvent,
  log = process.env.ACP_TUI_ACTIVE === '1'
    ? () => {}
    : (line) => process.stderr.write(`${line}\n`),
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
