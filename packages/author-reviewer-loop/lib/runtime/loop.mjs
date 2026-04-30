import { createLoopEngine } from '../engine.mjs';

/**
 * Backwards-compatible entry point: runs the loop and forwards every engine
 * event to the legacy renderer interface (onLaunching/onTurnStart/...).
 *
 * New code should prefer `createLoopEngine({ config })` directly so the
 * renderer can also read `engine.getState()` for its own redraws.
 */
export async function runAuthorReviewerLoop({ config, renderer }) {
  const engine = createLoopEngine({ config });
  if (renderer) {
    engine.onEvent((event) => {
      switch (event.type) {
        case 'launching':       return renderer.onLaunching?.();
        case 'roleStatus':      return renderer.onRoleStatus?.(event);
        case 'turnStart':       return renderer.onTurnStart?.(event);
        case 'turnSnapshot':    return renderer.onTurnSnapshot?.(event);
        case 'delta':           return renderer.onMessageDelta?.(event);
        case 'reasoningDelta':  return renderer.onReasoningDelta?.(event);
        case 'reasoningCompleted': return renderer.onReasoningCompleted?.(event);
        case 'planUpdate':      return renderer.onPlanUpdate?.(event);
        case 'toolStart':       return renderer.onToolStart?.(event);
        case 'toolUpdate':      return renderer.onToolUpdate?.(event);
        case 'toolEnd':         return renderer.onToolEnd?.(event);
        case 'traceEntry':      return renderer.onTraceEntry?.(event);
        case 'usageUpdate':     return renderer.onUsageUpdate?.(event);
        case 'turnCompleted':   return renderer.onTurnCompleted?.(event);
        case 'turnFailed':      return renderer.onTurnFailed?.(event);
        case 'turnEnd':         return renderer.onTurnEnd?.(event);
        case 'approvalPending': return renderer.onApprovalPending?.(event.result);
        case 'approvalContinued': return renderer.onApprovalContinued?.(event);
        case 'result':          return renderer.onResult?.(event.result);
        default:                return undefined;
      }
    });
  }
  return engine.run();
}

export { createLoopEngine } from '../engine.mjs';
