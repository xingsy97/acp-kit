import type { WireContext, WireMiddleware } from './host.js';

/**
 * Koa-style middleware composer. Returns a dispatcher that runs every
 * middleware and then `terminator` (the "real" wire send/receive). If any
 * middleware does not call `next`, the frame is dropped and `terminator`
 * never runs.
 *
 * Throws if `next` is called more than once within the same middleware (Koa
 * semantics), which catches a common middleware bug.
 */
export function composeWireMiddleware(
  middlewares: WireMiddleware[],
  terminator: (ctx: WireContext) => void | Promise<void>,
): (ctx: WireContext) => Promise<void> {
  return async function dispatch(ctx: WireContext): Promise<void> {
    let lastIndex = -1;
    const run = async (i: number): Promise<void> => {
      if (i <= lastIndex) {
        throw new Error('next() called multiple times in wire middleware');
      }
      lastIndex = i;
      const fn = middlewares[i];
      if (!fn) {
        await terminator(ctx);
        return;
      }
      let nextCalled = false;
      await fn(ctx, async () => {
        nextCalled = true;
        await run(i + 1);
      });
      // If middleware did not call next(), we treat the frame as dropped.
      // No further action needed; just suppress unused var warning.
      void nextCalled;
    };
    await run(0);
  };
}

/** Normalize host.wireMiddleware (single fn / array / undefined) into an array. */
export function normalizeWireMiddleware(
  value: WireMiddleware | WireMiddleware[] | undefined,
): WireMiddleware[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
