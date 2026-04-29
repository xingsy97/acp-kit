import { collectTurnResult } from '@acp-kit/core';

/**
 * Run a single author/reviewer turn. Core collects the ACP session events into
 * a turn result; this adapter only adds round/role metadata for renderers.
 */
export async function runTurn({ round, role, state, prompt, renderer }) {
  state.startupProfile?.once?.({
    phase: 'first turn request sent',
    at: Date.now(),
    detail: { round, promptChars: String(prompt ?? '').length },
  });
  renderer.onTurnStart?.({ round, role, at: Date.now() });
  let failureEmitted = false;
  let terminalFailure = null;
  let firstContentEventSeen = false;

  try {
    const result = await collectTurnResult(state.session, prompt, {
      onUpdate: (snapshot) => renderer.onTurnSnapshot?.({ round, role, snapshot }),
      onEvent: (event, snapshot) => {
        if (!event || typeof event !== 'object') return;
        state.startupProfile?.once?.({
          phase: 'first runtime event received',
          at: Date.now(),
          detail: { type: event.type },
        });
        if (!firstContentEventSeen && isContentBearingEvent(event.type)) {
          firstContentEventSeen = true;
          state.startupProfile?.once?.({
            phase: 'first message/reasoning/tool event received',
            at: Date.now(),
            detail: { type: event.type },
          });
        }
        const tools = Array.isArray(snapshot?.tools) ? snapshot.tools : [];
        switch (event.type) {
          case 'message.delta':
            renderer.onMessageDelta?.({ round, role, delta: event.delta });
            return;
          case 'reasoning.delta':
            renderer.onReasoningDelta?.({ round, role, delta: event.delta, reasoningId: event.reasoningId });
            return;
          case 'reasoning.completed':
            renderer.onReasoningCompleted?.({ round, role, reasoningId: event.reasoningId, content: event.content });
            return;
          case 'tool.start': {
            const tool = tools.find((item) => item.id === event.toolCallId);
            renderer.onToolStart?.({
              round,
              role,
              toolCallId: event.toolCallId,
              tag: tool?.tag ?? '#?',
              name: event.name,
              title: event.title || event.name,
              kind: event.kind,
              input: event.input,
              locations: event.locations,
              content: event.content,
            });
            return;
          }
          case 'tool.update': {
            const tool = tools.find((item) => item.id === event.toolCallId);
            renderer.onToolUpdate?.({
              round,
              role,
              toolCallId: event.toolCallId,
              tag: tool?.tag ?? '#?',
              title: event.title ?? tool?.title,
              status: event.status,
              chars: maxFinite(tool?.inputChars, tool?.outputChars),
              output: event.output,
              locations: event.locations,
              content: event.content,
            });
            return;
          }
          case 'tool.end': {
            const tool = tools.find((item) => item.id === event.toolCallId);
            renderer.onToolEnd?.({
              round,
              role,
              toolCallId: event.toolCallId,
              tag: tool?.tag ?? '#?',
              title: event.title ?? tool?.title,
              status: event.status,
              chars: maxFinite(tool?.inputChars, tool?.outputChars),
              output: event.output,
              locations: event.locations,
              content: event.content,
            });
            return;
          }
          case 'turn.completed':
            renderer.onTurnCompleted?.({ round, role, stopReason: event.stopReason ?? 'unknown', at: event.at ?? Date.now() });
            return;
          case 'turn.failed':
            terminalFailure = emitTerminalFailure({
              round,
              role,
              renderer,
              failure: terminalFailure,
              error: event.error,
              fallback: 'Turn failed',
              at: event.at,
            });
            failureEmitted = true;
            return;
          case 'turn.cancelled':
            terminalFailure = emitTerminalFailure({
              round,
              role,
              renderer,
              failure: terminalFailure,
              error: event.reason,
              fallback: 'Turn cancelled',
              at: event.at,
            });
            failureEmitted = true;
            return;
          case 'session.error':
            terminalFailure = emitTerminalFailure({
              round,
              role,
              renderer,
              failure: terminalFailure,
              error: event.message,
              fallback: 'Session error',
              at: event.at,
            });
            failureEmitted = true;
            return;
          default:
            return;
        }
      },
    });

    renderer.onTurnSnapshot?.({ round, role, snapshot: result });
    if (terminalFailure) throw new Error(terminalFailure.error);
    return typeof result.text === 'string' ? result.text : '';
  } catch (error) {
    if (!failureEmitted) {
      renderer.onTurnFailed?.({ round, role, error: formatError(error), at: Date.now() });
    }
    throw error;
  } finally {
    renderer.onTurnEnd?.({ round, role, at: Date.now() });
  }
}

function isContentBearingEvent(type) {
  return type === 'message.delta'
    || type === 'message.completed'
    || type === 'reasoning.delta'
    || type === 'reasoning.completed'
    || type === 'tool.start'
    || type === 'tool.update'
    || type === 'tool.end';
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function maxFinite(...values) {
  return values.reduce((max, value) => Number.isFinite(value) ? Math.max(max, value) : max, 0);
}

function emitTerminalFailure({ round, role, renderer, failure, error, fallback, at }) {
  if (failure) return failure;
  const next = { error: compactErrorMessage(error, fallback), at: at ?? Date.now() };
  renderer.onTurnFailed?.({ round, role, error: next.error, at: next.at });
  return next;
}

function compactErrorMessage(error, fallback) {
  const message = extractErrorMessage(error);
  return message || fallback;
}

function extractErrorMessage(error, depth = 0, seen = new WeakSet()) {
  if (typeof error === 'string') return error.trim();
  if (error instanceof Error) return error.message.trim();
  if (typeof error === 'number' || typeof error === 'boolean') return String(error);
  if (!error || typeof error !== 'object' || depth > 4) return '';
  if (seen.has(error)) return '';
  seen.add(error);

  for (const key of ['message', 'error', 'reason', 'detail', 'details', 'content', 'text']) {
    const nested = extractErrorMessage(error[key], depth + 1, seen);
    if (nested) return nested;
  }

  try {
    const serialized = JSON.stringify(error);
    return typeof serialized === 'string' ? serialized.trim() : '';
  } catch {
    return '';
  }
}
