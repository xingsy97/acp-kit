import { collectTurnResult } from '@acp-kit/core';

/**
 * Run a single author/reviewer turn. Core collects the ACP session events into
 * a turn result; this adapter only adds round/role metadata for renderers.
 */
export async function runTurn({ round, role, state, prompt, renderer }) {
  renderer.onTurnStart?.({ round, role });
  let failureEmitted = false;

  try {
    const result = await collectTurnResult(state.session, prompt, {
      onUpdate: (snapshot) => renderer.onTurnSnapshot?.({ round, role, snapshot }),
      onEvent: (event, snapshot) => {
        const tools = Array.isArray(snapshot?.tools) ? snapshot.tools : [];
        switch (event.type) {
          case 'message.delta':
            renderer.onMessageDelta?.({ round, role, delta: event.delta });
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
              input: event.input,
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
            });
            return;
          }
          case 'turn.completed':
            renderer.onTurnCompleted?.({ round, role, stopReason: event.stopReason ?? 'unknown' });
            return;
          case 'turn.failed':
            failureEmitted = true;
            renderer.onTurnFailed?.({ round, role, error: event.error });
            return;
          case 'turn.cancelled':
            failureEmitted = true;
            renderer.onTurnFailed?.({ round, role, error: event.reason });
            return;
          default:
            return;
        }
      },
    });

    renderer.onTurnSnapshot?.({ round, role, snapshot: result });
    return typeof result.text === 'string' ? result.text : '';
  } catch (error) {
    if (!failureEmitted) {
      renderer.onTurnFailed?.({ round, role, error: formatError(error) });
    }
    throw error;
  } finally {
    renderer.onTurnEnd?.({ round, role });
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function maxFinite(...values) {
  return values.reduce((max, value) => Number.isFinite(value) ? Math.max(max, value) : max, 0);
}
