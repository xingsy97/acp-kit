import fs from 'node:fs/promises';
import { PaneStatus, Phase, initialState, reduce } from './engine/state.mjs';
import { closeRole, openRole } from './runtime/role.mjs';
import { runTurn } from './runtime/turn.mjs';

export { PaneStatus, Phase };

function isApprovedVerdict(text) {
  return text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .split(/\r?\n/)
    .some((line) => /^APPROVED\.?$/i.test(line.trim()));
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
    onToolStart: (event) => publish(
      { type: 'toolStart', ...event },
      { type: 'toolStart', status: PaneStatus.Running, flowId: nextFlowId++, ...event },
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
      [author, reviewer] = await openRoles({
        authorSettings,
        reviewerSettings,
        cwd,
        trace,
        captureTrace: trace,
        renderer: innerRenderer,
      });

      const result = await runRounds({
        author,
        reviewer,
        maxRounds,
        cwd,
        config,
        authorSettings,
        reviewerSettings,
        renderer: innerRenderer,
      });
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

    feedback = reply.trim();
    approved = isApprovedVerdict(feedback);
    if (!approved) continue;

    const result = { approved: true, feedback, maxRounds: roundLimit, rounds: lastRound, cwd };
    renderer.onResult(result);
    const decision = await config.onApproved?.(result);
    if (!decision?.continue) return result;

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

async function openRoles({ authorSettings, reviewerSettings, cwd, trace, captureTrace, renderer }) {
  const [authorResult, reviewerResult] = await Promise.allSettled([
    openRole({ role: 'AUTHOR', settings: authorSettings, cwd, trace, captureTrace, renderer }),
    openRole({ role: 'REVIEWER', settings: reviewerSettings, cwd, trace, captureTrace, renderer }),
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
