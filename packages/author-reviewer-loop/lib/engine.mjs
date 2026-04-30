import fs from 'node:fs/promises';
import { PaneStatus, Phase, initialState, reduce } from './engine/state.mjs';
import { closeRole, openRole } from './runtime/role.mjs';
import { createStartupProfiler } from './runtime/startup-profile.mjs';
import { runTurn } from './runtime/turn.mjs';

export { PaneStatus, Phase };

const EMPTY_REVIEWER_FEEDBACK = [
  'Reviewer returned an empty response.',
  '',
  'Do not assume approval. Re-run verification, summarize the current state clearly, and reply with APPROVED on the first non-empty line only when the workspace is truly ready.',
].join('\n');

const AMBIGUOUS_APPROVAL_FEEDBACK = [
  'Reviewer response was treated as NOT APPROVED because it mixed APPROVED with conflicting issue text.',
  '',
  'Put APPROVED on the first non-empty line and keep follow-up notes free of rejection language or issue lists.',
].join('\n');

const APPROVAL_NEGATIVE_SIGNAL = /\b(?:fail(?:s|ed|ing)?|broken|missing|issue|problem|todo|remaining|regress(?:ion|ed|ing)?|blocked|incomplete|unverified|cannot|can't|won't|does(?:\s+not|n't)\s+work|timed?\s*out|timeout|error(?:s)?|crash(?:ed|es|ing)?)\b/;
const APPROVAL_STATUS_SUBJECT = /^(?:verification|validation|review|checks?|tests?|test suite|build|startup|restart(?: recovery)?|recovery|resume|interruption|windows|linux|macos|path handling|persistence|state|flow|loop|output|session|tooling?)\b/;

function sanitizeReviewerText(text) {
  return String(text ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r/g, '');
}

function isApprovedVerdictLine(line) {
  const normalized = line.replace(/\s+/g, ' ').trim();
  if (!/^APPROVED\b/i.test(normalized)) return false;
  const trailing = normalized
    .replace(/^APPROVED\b/i, '')
    .replace(/^[\s:;,.!_\-–—]+/, '')
    .trim();
  if (!trailing) return true;
  if (/^(?:if|but|however|except|unless|pending|assuming|subject\s+to)\b/i.test(trailing)) return false;
  return !isConflictingApprovalLine(trailing);
}

function isConflictingApprovalLine(line) {
  const normalized = line.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  const prefixStripped = normalized.replace(/^(?:[-*]|\d+[.)])\s*/, '');
  if (isResolvedHistoricalFailure(prefixStripped)) return false;
  if (isCleanApprovalNote(prefixStripped)) return false;
  if (/\b(?:not approved|cannot approve|can't approve|do not approve|rejected)\b/.test(prefixStripped)) return true;
  if (/^(?:issues?|problems?|remaining(?: issues?)?|fix(?:es)?|todo)\b/.test(prefixStripped)) return true;
  if (/^(?:[-*]|\d+[.)])\s*(?:fix|missing|issue|problem|todo|remaining|still|cannot|can't|do not approve|not approved|rejected)\b/.test(normalized)) return true;
  if (/\b(?:however|but|except|although|though|yet)\b/.test(prefixStripped) && APPROVAL_NEGATIVE_SIGNAL.test(prefixStripped)) return true;
  if (/\b(?:still|remains?|remaining)\b.*\b(?:fail(?:s|ed|ing)?|broken|missing|issue|problem|todo|regress(?:ion|ed|ing)?|blocked|incomplete|unverified)\b/.test(prefixStripped)) return true;
  if (APPROVAL_STATUS_SUBJECT.test(prefixStripped) && APPROVAL_NEGATIVE_SIGNAL.test(prefixStripped)) return true;
  if (prefixStripped !== normalized && APPROVAL_NEGATIVE_SIGNAL.test(prefixStripped)) return true;
  return false;
}

function isCleanApprovalNote(line) {
  if (/\b(?:however|but|except|although|though|yet)\b/.test(line)) return false;
  const cleaned = line.split(/(?<=[.!?])\s+/).map((sentence) => sentence
    .replace(/\bno\s+(?:known\s+|open\s+|new\s+|remaining\s+)?(?:issues?|problems?|todos?|failures?|errors?|regressions?|blockers?|crashes?|timeouts?)\b/g, '')
    .replace(/\bno\s+(?:failing|broken|missing|blocked|incomplete|unverified)\s+[a-z0-9_-]+\b/g, '')
    .replace(/^(?:issues?|problems?|todos?|failures?|errors?|regressions?|blockers?)\s*[:—-]?\s*(?:none|resolved|fixed|closed|clear)\.?/g, '')
    .trim()).join(' ').trim();
  return cleaned !== line && !APPROVAL_NEGATIVE_SIGNAL.test(cleaned);
}

function isResolvedHistoricalFailure(line) {
  return /\b(?:previously|formerly|once|earlier)\b.*\b(?:fail(?:ed|ing)?|broken|missing|regress(?:ed|ing)?|blocked|incomplete|unverified)\b.*\b(?:fixed|resolved|verified|passed|working|ready)\b/.test(line)
    || /\b(?:fixed|resolved|verified|passed|working|ready)\b.*\b(?:previously|formerly|once|earlier)\b.*\b(?:fail(?:ed|ing)?|broken|missing|regress(?:ed|ing)?|blocked|incomplete|unverified)\b/.test(line);
}

function interpretReviewerReply(text) {
  const feedback = sanitizeReviewerText(text).trim();
  const meaningfulLines = feedback
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (meaningfulLines.length === 0) {
    return { approved: false, feedback: EMPTY_REVIEWER_FEEDBACK };
  }

  if (!isApprovedVerdictLine(meaningfulLines[0])) {
    return { approved: false, feedback };
  }

  const conflictingLine = meaningfulLines.slice(1).find(isConflictingApprovalLine);
  if (conflictingLine) {
    return {
      approved: false,
      feedback: `${feedback}\n\n${AMBIGUOUS_APPROVAL_FEEDBACK}`,
    };
  }

  return { approved: true, feedback };
}

export function createLoopEngine({ config }) {
  let state = initialState();
  const listeners = new Set();
  const eventListeners = new Set();
  let nextFlowId = 1;
  let nextTraceId = 1;

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
    onMessageDelta: (event) => publish(
      { type: 'delta', ...event },
      { type: 'delta', flowId: nextFlowId++, ...event },
    ),
    onReasoningDelta: (event) => publish(
      { type: 'reasoningDelta', ...event },
      { type: 'reasoningDelta', flowId: nextFlowId++, ...event },
    ),
    onReasoningCompleted: (event) => publish(
      { type: 'reasoningCompleted', ...event },
      { type: 'reasoningCompleted', ...event },
    ),
    onPlanUpdate: (event) => publish(
      { type: 'planUpdate', ...event },
      { type: 'planUpdate', at: Date.now(), ...event },
    ),
    onToolStart: (event) => publish(
      { type: 'toolStart', ...event },
      { type: 'toolStart', status: PaneStatus.Running, flowId: nextFlowId++, ...event },
    ),
    onToolUpdate: (event) => publish(
      { type: 'toolUpdate', ...event },
      { type: 'toolUpdate', flowId: nextFlowId++, ...event },
    ),
    onToolEnd: (event) => publish(
      { type: 'toolEnd', ...event },
      { type: 'toolEnd', flowId: nextFlowId++, ...event },
    ),
    onTraceEntry: (event) => publish(
      { type: 'traceEntry', ...event },
      { type: 'traceEntry', traceId: nextTraceId++, ...event },
    ),
    onUsageUpdate: (event) => publish(
      { type: 'usageUpdate', ...event },
      { type: 'usageUpdate', ...event },
    ),
    onTurnCompleted: (event) => publish({ type: 'turnCompleted', ...event }, { type: 'turnCompleted', ...event }),
    onTurnFailed: (event) => publish({ type: 'turnFailed', ...event }, { type: 'turnFailed', ...event }),
    onTurnEnd: (event) => publish({ type: 'turnEnd', ...event }, { type: 'turnEnd', ...event }),
    onResult: (result) => publish({ type: 'result', result }, { type: 'result', result }),
  };

  async function run() {
    const { cwd, maxRounds, trace, tui, authorSettings, reviewerSettings } = config;
    const openRoleFn = config.openRole || openRole;
    const closeRoleFn = config.closeRole || closeRole;
    const retiredRoles = new Set();

    let startup;
    let authorManager;
    let reviewerManager;
    let result;
    let runError;
    try {
      await fs.mkdir(cwd, { recursive: true });
      innerRenderer.onLaunching();
      startup = startRoles({
        authorSettings,
        reviewerSettings,
        cwd,
        trace,
        captureTrace: Boolean(trace || tui),
        renderer: innerRenderer,
        openRole: openRoleFn,
      });
      authorManager = createRoleSessionManager({
        role: 'AUTHOR',
        settings: authorSettings,
        getInitialRole: () => startup.getAuthor(),
        openRole: openRoleFn,
        closeRole: closeRoleFn,
        cwd,
        trace,
        captureTrace: Boolean(trace || tui),
        renderer: innerRenderer,
        maxTurns: authorSettings.sessionTurns,
        retiredRoles,
      });
      reviewerManager = createRoleSessionManager({
        role: 'REVIEWER',
        settings: reviewerSettings,
        getInitialRole: () => startup.getReviewer(),
        openRole: openRoleFn,
        closeRole: closeRoleFn,
        cwd,
        trace,
        captureTrace: Boolean(trace || tui),
        renderer: innerRenderer,
        maxTurns: reviewerSettings.sessionTurns,
        retiredRoles,
      });

      result = await runRounds({
        authorManager,
        reviewerManager,
        maxRounds,
        cwd,
        config,
        authorSettings,
        reviewerSettings,
        renderer: innerRenderer,
      });
    } catch (error) {
      runError = await normalizeStartupError({ startup, author: authorManager?.getActive(), error });
      const message = formatErrorMessage(runError);
      dispatch({ type: 'error', error: message });
      emit({ type: 'error', error: runError });
    }

    const startedRoles = await collectStartedRoles({ startup, managers: [authorManager, reviewerManager] });
    const stopLateRoleCleanup = runError
      ? closeLateStartingRoles({
        startup,
        closeRoleFn,
        ignoredStates: startedRoles,
        retiredRoles,
      })
      : () => {};

    const closeError = await closeRoles(
      closeRoleFn,
      startedRoles.filter((state) => !retiredRoles.has(state)),
    );
    if (!runError) stopLateRoleCleanup();
    if (runError && closeError) {
      throw new AggregateError(
        [runError, ...toErrorList(closeError)],
        'Author-reviewer loop failed and cleanup also failed.',
      );
    }
    if (runError) throw runError;
    if (closeError) throw closeError;
    return result;
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

async function runRounds({ authorManager, reviewerManager, maxRounds, cwd, config, authorSettings, reviewerSettings, renderer }) {
  maxRounds = normalizeRoundLimit(maxRounds);
  let feedback = '';
  let approved = false;
  let lastRound = 0;
  let roundLimit = maxRounds;
  let approvalContinuations = 0;
  const continuationLimit = normalizeApprovalContinuationLimit(config.maxApprovalContinuations, maxRounds);
  const hardRoundLimit = maxRounds + continuationLimit;

  for (let round = 1; round <= roundLimit; round++) {
    lastRound = round;
    const author = await authorManager.getForTurn();
    const authorReply = await runTurn({
      round,
      role: 'AUTHOR',
      state: author,
      prompt: authorSettings.prompt({ round, feedback }),
      renderer,
    });
    const reviewer = await reviewerManager.getForTurn();
    const reply = await runTurn({
      round,
      role: 'REVIEWER',
      state: reviewer,
      prompt: reviewerSettings.prompt({ round, feedback, authorReply }),
      renderer,
      });

      ({ approved, feedback } = interpretReviewerReply(reply));
      if (!approved) continue;

    const result = { approved: true, feedback, maxRounds: roundLimit, rounds: lastRound, cwd };
    const decision = await config.onApproved?.(result);
    if (!decision?.continue) {
      renderer.onResult(result);
      return result;
    }

    if (approvalContinuations >= continuationLimit || round >= hardRoundLimit) {
      const cappedResult = {
        ...result,
        maxRounds: hardRoundLimit,
        continuationLimitReached: true,
        feedback: `${feedback}\n\nApproval continuation limit reached after ${approvalContinuations} continuation(s).`,
      };
      renderer.onResult(cappedResult);
      return cappedResult;
    }

    approvalContinuations += 1;
    approved = false;
    if (round === roundLimit) roundLimit = Math.min(roundLimit + 1, hardRoundLimit);
    feedback = decision.feedback || `The task changed after approval. Continue with the updated task:\n${config.task}`;
  }

  const result = { approved, feedback, maxRounds: roundLimit, rounds: lastRound, cwd };
  renderer.onResult(result);
  return result;
}

/**
 * Normalize the base round budget for programmatic callers.
 * Positive integers are preserved. Any zero, negative, fractional, or
 * non-finite value falls back to at least one executable round.
 */
function normalizeRoundLimit(value) {
  if (Number.isInteger(value) && value >= 1) return value;
  if (Number.isFinite(value)) return Math.max(1, Math.trunc(value));
  return 1;
}

/**
 * Normalize post-approval continuation budgets.
 * Only non-negative integers are accepted. Any fractional, negative, or
 * non-finite value falls back to the already-normalized base round budget so
 * reopened approval loops stay deterministic for programmatic callers.
 */
function normalizeApprovalContinuationLimit(value, fallback) {
  if (Number.isInteger(value) && value >= 0) return value;
  return fallback;
}

function startRoles({ authorSettings, reviewerSettings, cwd, trace, captureTrace, renderer, openRole: openRoleFn = openRole }) {
  const startupProfile = createStartupProfiler({ scope: 'loop-startup' });
  let author;
  let reviewer;
  let authorError;
  let reviewerError;
  let authorSettled = false;
  let reviewerSettled = false;
  const settledListeners = new Set();

  function notifyRoleSettled(event) {
    for (const listener of settledListeners) listener(event);
  }

  const authorPromise = Promise.resolve()
    .then(() => openRoleFn({ role: 'AUTHOR', settings: authorSettings, cwd, trace, captureTrace, renderer }))
    .then((state) => {
      author = state;
      authorSettled = true;
      notifyRoleSettled({ role: 'AUTHOR', state });
      return state;
    }, (error) => {
      authorError = toError(error);
      authorSettled = true;
      notifyRoleSettled({ role: 'AUTHOR', error: authorError });
      throw error;
    });

  const reviewerPromise = Promise.resolve()
    .then(() => openRoleFn({ role: 'REVIEWER', settings: reviewerSettings, cwd, trace, captureTrace, renderer }))
    .then((state) => {
      reviewer = state;
      reviewerSettled = true;
      notifyRoleSettled({ role: 'REVIEWER', state });
      startupProfile.mark({
        phase: 'reviewer role ready',
        detail: {
          reviewerAgent: reviewer?.session?.agent?.displayName ?? reviewerSettings.agent?.displayName,
        },
      });
      return state;
    }, (error) => {
      reviewerError = toError(error);
      reviewerSettled = true;
      notifyRoleSettled({ role: 'REVIEWER', error: reviewerError });
      throw error;
    });

  const bothReadyPromise = Promise.all([authorPromise, reviewerPromise]).then(([readyAuthor, readyReviewer]) => {
    startupProfile.mark({
      phase: 'both roles ready',
      detail: {
        authorAgent: readyAuthor?.session?.agent?.displayName ?? authorSettings.agent?.displayName,
        reviewerAgent: readyReviewer?.session?.agent?.displayName ?? reviewerSettings.agent?.displayName,
      },
    });
  });
  bothReadyPromise.catch(() => undefined);

  return {
    async getAuthor() {
      return authorPromise;
    },
    async getReviewer() {
      return reviewerPromise;
    },
    getStartedRoles() {
      return [author, reviewer].filter(Boolean);
    },
    async settleStartedRoles() {
      if (!authorSettled || !reviewerSettled) {
        await Promise.allSettled([authorPromise, reviewerPromise]);
      }
      return [author, reviewer].filter(Boolean);
    },
    async getStartupFailures({ waitForPending = true } = {}) {
      if (waitForPending && (!authorSettled || !reviewerSettled)) {
        await Promise.allSettled([authorPromise, reviewerPromise]);
      }
      return [authorError, reviewerError].filter(Boolean);
    },
    onRoleSettled(listener) {
      settledListeners.add(listener);
      return () => settledListeners.delete(listener);
    },
  };
}

function createRoleSessionManager({ role, settings, getInitialRole, openRole: openRoleFn, closeRole: closeRoleFn, cwd, trace, captureTrace, renderer, maxTurns, retiredRoles }) {
  const turnLimit = normalizeSessionTurnLimit(maxTurns);
  const startedRoles = new Set();
  let active = null;
  let initialConsumed = false;
  let turnsOnActiveSession = 0;

  async function openFreshRole() {
    const state = await openRoleFn({ role, settings, cwd, trace, captureTrace, renderer });
    startedRoles.add(state);
    return state;
  }

  async function ensureActiveRole() {
    if (active) return active;
    active = initialConsumed ? await openFreshRole() : await getInitialRole();
    initialConsumed = true;
    startedRoles.add(active);
    turnsOnActiveSession = 0;
    return active;
  }

  async function refreshRole() {
    const previous = active;
    active = null;
    renderer.onRoleStatus?.({ role, message: 'refreshing session after ' + turnLimit + ' turn(s)...' });
    try {
      await closeRoleFn(previous);
      retiredRoles.add(previous);
    } catch {
      // Final cleanup will retry closing this state and report persistent failures.
    }
    active = await openFreshRole();
    turnsOnActiveSession = 0;
  }

  return {
    async getForTurn() {
      await ensureActiveRole();
      if (turnsOnActiveSession >= turnLimit) await refreshRole();
      turnsOnActiveSession += 1;
      return active;
    },
    getActive() {
      return active;
    },
    getStartedRoles() {
      return Array.from(startedRoles);
    },
  };
}

function normalizeSessionTurnLimit(value) {
  if (Number.isInteger(value) && value >= 1) return value;
  return 20;
}

async function normalizeStartupError({ startup, author, error }) {
  if (!startup || author) return error;
  const failures = await startup.getStartupFailures({ waitForPending: false });
  if (failures.length > 1) return new AggregateError(failures, 'Role startup failed.');
  return failures[0] ?? error;
}

async function collectStartedRoles({ startup, managers = [] }) {
  const managerRoles = managers.flatMap((manager) => manager?.getStartedRoles?.() ?? []);
  if (!startup) return Array.from(new Set(managerRoles.filter(Boolean)));
  return Array.from(new Set([...startup.getStartedRoles(), ...managerRoles].filter(Boolean)));
}

function closeLateStartingRoles({ startup, closeRoleFn, ignoredStates = [], retiredRoles = new Set() }) {
  if (!startup?.onRoleSettled) return () => {};
  const ignored = new Set(ignoredStates.filter(Boolean));
  return startup.onRoleSettled(({ state }) => {
    if (!state || ignored.has(state) || retiredRoles.has(state)) return;
    ignored.add(state);
    Promise.resolve()
      .then(() => closeRoleFn(state))
      .catch(() => undefined);
  });
}
async function closeRoles(closeRoleFn, states) {
  const activeStates = states.filter(Boolean);
  if (activeStates.length === 0) return null;
  const results = await Promise.allSettled(
    activeStates.map((state) => Promise.resolve().then(() => closeRoleFn(state))),
  );
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length === 0) return null;
  if (errors.length === 1) return toError(errors[0]);
  return new AggregateError(errors.map((error) => toError(error)), 'Failed to close author/reviewer roles.');
}

function toErrorList(error) {
  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    return error.errors.map((item) => toError(item));
  }
  return [toError(error)];
}

function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function formatErrorMessage(error) {
  if (error instanceof Error && error.name === 'ConfigurationError') return error.message;
  return error instanceof Error ? error.stack || error.message : String(error);
}
