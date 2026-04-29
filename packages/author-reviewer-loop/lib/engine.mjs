import fs from 'node:fs/promises';
import { PaneStatus, Phase, initialState, reduce } from './engine/state.mjs';
import { closeRole, openRole } from './runtime/role.mjs';
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

function sanitizeReviewerText(text) {
  return String(text ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r/g, '');
}

function isApprovedVerdictLine(line) {
  return /^APPROVED\.?$/i.test(line.trim());
}

function isConflictingApprovalLine(line) {
  const normalized = line.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  if (/\b(?:not approved|cannot approve|can't approve|do not approve|rejected)\b/.test(normalized)) return true;
  if (/^(?:issues?|problems?|remaining(?: issues?)?|fix(?:es)?|todo)\b/.test(normalized)) return true;
  if (/^(?:[-*]|\d+[.)])\s*(?:fix|missing|issue|problem|todo|remaining|still|cannot|can't|do not approve|not approved|rejected)\b/.test(normalized)) return true;
  if (/\b(?:however|but|except|although|though|yet)\b.*\b(?:fail(?:s|ed|ing)?|broken|missing|issue|problem|todo|remaining|regress(?:ion|ed|ing)?|blocked|incomplete|unverified|cannot|can't|won't|does(?:\s+not|n't)\s+work)\b/.test(normalized)) return true;
  if (/\b(?:still|remains?|remaining)\b.*\b(?:fail(?:s|ed|ing)?|broken|missing|issue|problem|todo|regress(?:ion|ed|ing)?|blocked|incomplete|unverified)\b/.test(normalized)) return true;
  return false;
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

    let author;
    let reviewer;
    let result;
    let runError;
    try {
      await fs.mkdir(cwd, { recursive: true });
      innerRenderer.onLaunching();
      [author, reviewer] = await openRoles({
        authorSettings,
        reviewerSettings,
        cwd,
        trace,
        captureTrace: Boolean(trace || tui),
        renderer: innerRenderer,
        openRole: openRoleFn,
        closeRole: closeRoleFn,
      });

      result = await runRounds({
        author,
        reviewer,
        maxRounds,
        cwd,
        config,
        authorSettings,
        reviewerSettings,
        renderer: innerRenderer,
      });
    } catch (error) {
      runError = error;
      const message = formatErrorMessage(error);
      dispatch({ type: 'error', error: message });
      emit({ type: 'error', error });
    }

    const closeError = await closeRoles(closeRoleFn, [author, reviewer]);
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

async function runRounds({ author, reviewer, maxRounds, cwd, config, authorSettings, reviewerSettings, renderer }) {
  let feedback = '';
  let approved = false;
  let lastRound = 0;
  let roundLimit = maxRounds;
  let approvalContinuations = 0;
  const continuationLimit = normalizeApprovalContinuationLimit(config.maxApprovalContinuations, maxRounds);
  const hardRoundLimit = maxRounds + continuationLimit;

  for (let round = 1; round <= roundLimit; round++) {
    lastRound = round;
    const authorReply = await runTurn({
      round,
      role: 'AUTHOR',
      state: author,
      prompt: authorSettings.prompt({ round, feedback }),
      renderer,
    });
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

function normalizeApprovalContinuationLimit(value, fallback) {
  if (Number.isInteger(value) && value >= 0) return value;
  return fallback;
}

async function openRoles({ authorSettings, reviewerSettings, cwd, trace, captureTrace, renderer, openRole: openRoleFn = openRole, closeRole: closeRoleFn = closeRole }) {
  const [authorResult, reviewerResult] = await Promise.allSettled([
    openRoleFn({ role: 'AUTHOR', settings: authorSettings, cwd, trace, captureTrace, renderer }),
    openRoleFn({ role: 'REVIEWER', settings: reviewerSettings, cwd, trace, captureTrace, renderer }),
  ]);

  const author = authorResult.status === 'fulfilled' ? authorResult.value : undefined;
  const reviewer = reviewerResult.status === 'fulfilled' ? reviewerResult.value : undefined;

  const failures = [authorResult, reviewerResult]
    .filter((result) => result.status === 'rejected')
    .map((result) => toError(result.reason));
  if (failures.length > 0) {
    const startupError = failures.length === 1
      ? failures[0]
      : new AggregateError(failures, 'Role startup failed.');
    const closeError = await closeRoles(closeRoleFn, [author, reviewer]);
    if (closeError) {
      throw new AggregateError(
        [...toErrorList(startupError), ...toErrorList(closeError)],
        'Role startup failed and cleanup also failed.',
      );
    }
    throw startupError;
  }

  return [author, reviewer];
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
