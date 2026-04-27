import { collectTurnResult } from '@acp-kit/core';

/**
 * Run a single author/reviewer turn. Core collects the ACP session events into
 * a turn result; this adapter only adds round/role metadata for renderers.
 */
export async function runTurn({ round, role, state, prompt, renderer }) {
  renderer.onTurnStart?.({ round, role });

  const result = await collectTurnResult(state.session, prompt, {
    onUpdate: (snapshot) => renderer.onTurnSnapshot?.({ round, role, snapshot }),
    onEvent: (event, snapshot) => {
      switch (event.type) {
        case 'message.delta':
          renderer.onMessageDelta?.({ round, role, delta: event.delta });
          return;
        case 'tool.start': {
          const tool = snapshot.tools.find((item) => item.id === event.toolCallId);
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
          const tool = snapshot.tools.find((item) => item.id === event.toolCallId);
          renderer.onToolEnd?.({
            round,
            role,
            toolCallId: event.toolCallId,
            tag: tool?.tag ?? '#?',
            title: event.title ?? tool?.title,
            status: event.status,
            chars: Math.max(tool?.inputChars ?? 0, tool?.outputChars ?? 0),
            output: event.output,
          });
          return;
        }
        case 'turn.completed':
          renderer.onTurnCompleted?.({ round, role, stopReason: event.stopReason ?? 'unknown' });
          return;
        case 'turn.failed':
          renderer.onTurnFailed?.({ round, role, error: event.error });
          return;
        case 'turn.cancelled':
          renderer.onTurnFailed?.({ round, role, error: event.reason });
          return;
        default:
          return;
      }
    },
  });

  renderer.onTurnEnd?.({ round, role });
  renderer.onTurnSnapshot?.({ round, role, snapshot: result });
  return result.text;
}
