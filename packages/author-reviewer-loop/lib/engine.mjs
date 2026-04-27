import fs from 'node:fs/promises';
import { closeRole, openRole } from './runtime/role.mjs';
import { runTurn } from './runtime/turn.mjs';

/**
 * Author/Reviewer engine.
 *
 * Owns:
 *   - the business loop (open roles, alternate AUTHOR/REVIEWER turns until APPROVED)
 *   - a reduced state tree describing every round's panes, tools, statuses
 *   - a tiny subscribe()/getState() API so any renderer (plain, ink, html, ...)
 *     can observe the run without re-implementing bookkeeping.
 *
 * Renderers are now passive views over `engine.getState()` plus the stream of
 * normalized events delivered to subscribers. The engine itself does not draw.
 */

export const PaneStatus = Object.freeze({
  Pending: 'pending',
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
});

export const Phase = Object.freeze({
  Idle: 'idle',
  Launching: 'launching',
  Running: 'running',
  Done: 'done',
  Error: 'error',
});

function emptyPane() {
  return {
    status: PaneStatus.Pending,
    lines: [],          // committed text lines (split by \n)
    current: '',        // the not-yet-newline-terminated tail
    tools: [],          // [{ id, tag, title, status, chars }]
    stopReason: null,
    error: null,
    chars: 0,           // total streamed characters
  };
}

function paneFromTurnSnapshot(snapshot) {
  const parts = snapshot.text.split('\n');
  const current = parts.pop() ?? '';
  const status = snapshot.status === 'completed'
    ? PaneStatus.Completed
    : snapshot.status === 'failed' || snapshot.status === 'cancelled'
      ? PaneStatus.Failed
      : PaneStatus.Running;
  return {
    status,
    lines: parts,
    current,
    tools: snapshot.tools.map((tool) => ({
      id: tool.id,
      tag: tool.tag,
      title: tool.title || tool.name || tool.id,
      status: tool.status,
      chars: Math.max(tool.inputChars, tool.outputChars),
    })),
    stopReason: snapshot.stopReason,
    error: snapshot.error,
    chars: snapshot.text.length,
  };
}

function emptyRound() {
  return { AUTHOR: emptyPane(), REVIEWER: emptyPane() };
}

function initialState() {
  return {
    phase: Phase.Idle,
    statuses: { AUTHOR: 'pending', REVIEWER: 'pending' },
    rounds: new Map(),   // round number -> { AUTHOR, REVIEWER }
    order: [],           // sorted round numbers
    latest: null,        // latest round number with activity
    result: null,        // final RunResult
    error: null,         // error string if phase === 'error'
    startedAt: null,
    finishedAt: null,
  };
}

function ensureRound(state, round) {
  if (state.rounds.has(round)) return state;
  const rounds = new Map(state.rounds);
  rounds.set(round, emptyRound());
  const order = [...state.order];
  if (!order.includes(round)) {
    order.push(round);
    order.sort((a, b) => a - b);
  }
  return { ...state, rounds, order, latest: order[order.length - 1] };
}

function patchPane(state, round, role, mutate) {
  const rounds = new Map(state.rounds);
  const entry = rounds.get(round) || emptyRound();
  rounds.set(round, { ...entry, [role]: mutate({ ...entry[role] }) });
  return { ...state, rounds };
}

function reduce(state, action) {
  switch (action.type) {
    case 'launching':
      return { ...state, phase: Phase.Launching, startedAt: state.startedAt ?? Date.now() };
    case 'roleStatus':
      return { ...state, statuses: { ...state.statuses, [action.role]: action.message } };
    case 'turnStart': {
      const next = ensureRound(state, action.round);
      next.phase = Phase.Running;
      return patchPane(next, action.round, action.role, (p) => ({ ...p, status: PaneStatus.Running }));
    }
    case 'turnSnapshot': {
      const next = ensureRound(state, action.round);
      return patchPane(next, action.round, action.role, () => paneFromTurnSnapshot(action.snapshot));
    }
    case 'result':
      return { ...state, phase: Phase.Done, result: action.result, finishedAt: Date.now() };
    case 'error':
      return { ...state, phase: Phase.Error, error: action.error, finishedAt: Date.now() };
    default:
      return state;
  }
}

function isApprovedVerdict(text) {
  return text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .split(/\r?\n/)
    .some((line) => /^APPROVED\.?$/i.test(line.trim()));
}

/**
 * Build a new engine. The engine does NOT auto-start; call `engine.run()`.
 *
 * @param {object} options
 * @param {object} options.config  parsed run configuration
 */
export function createLoopEngine({ config }) {
  let state = initialState();
  const listeners = new Set();
  const eventListeners = new Set();

  function dispatch(action) {
    state = reduce(state, action);
    for (const fn of listeners) fn(state, action);
  }

  function emit(event) {
    for (const fn of eventListeners) fn(event);
  }

  const publish = (event, action = event) => {
    if (action) dispatch(action);
    emit(event);
  };

  const innerRenderer = {
    onLaunching: () => publish({ type: 'launching' }),
    onRoleStatus: (event) => publish({ type: 'roleStatus', ...event }),
    onTurnStart: (event) => publish({ type: 'turnStart', ...event }),
    onTurnSnapshot: (event) => publish(
      { type: 'turnSnapshot', ...event },
      { type: 'turnSnapshot', round: event.round, role: event.role, snapshot: event.snapshot },
    ),
    onMessageDelta: (event) => publish({ type: 'delta', ...event }, null),
    onToolStart: (event) => publish({ type: 'toolStart', ...event }, null),
    onToolEnd: (event) => publish({ type: 'toolEnd', ...event }, null),
    onTurnCompleted: (event) => publish({ type: 'turnCompleted', ...event }, null),
    onTurnFailed: (event) => publish({ type: 'turnFailed', ...event }, null),
    onTurnEnd: (event) => publish({ type: 'turnEnd', ...event }, null),
    onResult: (result) => publish({ type: 'result', result }, { type: 'result', result }),
  };

  async function run() {
    const { cwd, maxRounds, trace, authorSettings, reviewerSettings } = config;
    await fs.mkdir(cwd, { recursive: true });

    innerRenderer.onLaunching();

    let author;
    let reviewer;
    try {
      [author, reviewer] = await openRoles({ authorSettings, reviewerSettings, cwd, trace, renderer: innerRenderer });

      let feedback = '';
      let approved = false;
      let lastRound = 0;

      for (let round = 1; round <= maxRounds && !approved; round++) {
        lastRound = round;
        await runTurn({
          round,
          role: 'AUTHOR',
          state: author,
          prompt: authorSettings.prompt({ round, feedback }),
          renderer: innerRenderer,
        });
        const reply = await runTurn({
          round,
          role: 'REVIEWER',
          state: reviewer,
          prompt: reviewerSettings.prompt({ round, feedback }),
          renderer: innerRenderer,
        });

        feedback = reply.trim();
        approved = isApprovedVerdict(feedback);
      }

      const result = { approved, feedback, maxRounds, rounds: lastRound, cwd };
      innerRenderer.onResult(result);
      return result;
    } catch (error) {
      const message = formatErrorMessage(error);
      dispatch({ type: 'error', error: message });
      emit({ type: 'error', error });
      throw error;
    } finally {
      await closeRole(author);
      await closeRole(reviewer);
    }
  }

  return {
    config,
    getState: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onEvent: (fn) => {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    run,
  };
}

async function openRoles({ authorSettings, reviewerSettings, cwd, trace, renderer }) {
  const [authorResult, reviewerResult] = await Promise.allSettled([
    openRole({ role: 'AUTHOR', settings: authorSettings, cwd, trace, renderer }),
    openRole({ role: 'REVIEWER', settings: reviewerSettings, cwd, trace, renderer }),
  ]);

  const author = authorResult.status === 'fulfilled' ? authorResult.value : undefined;
  const reviewer = reviewerResult.status === 'fulfilled' ? reviewerResult.value : undefined;

  const failure = [authorResult, reviewerResult].find((result) => result.status === 'rejected');
  if (failure) {
    await closeRole(author);
    await closeRole(reviewer);
    throw failure.reason;
  }

  return [author, reviewer];
}

function formatErrorMessage(error) {
  if (error instanceof Error && error.name === 'ConfigurationError') return error.message;
  return error instanceof Error ? error.stack || error.message : String(error);
}
