import process from 'node:process';

/**
 * Plain console renderer. Subscribes to engine events and prints them as a
 * scrolling line-based log. Identical visual output to the original CLI; the
 * difference is that bookkeeping now lives in the engine, not here.
 */
export function createPlainRenderer() {
  let midLine = false;

  const lineFeed = () => {
    if (midLine) {
      process.stdout.write('\n');
      midLine = false;
    }
  };

  return {
    /**
     * Wire this renderer to a loop engine. Returns the unsubscribe function.
     */
    attach(engine) {
      return engine.onEvent((event) => {
        switch (event.type) {
          case 'launching':
            console.log('Launching agents in parallel (this can take a few seconds on cold start)...');
            return;
          case 'roleStatus':
            console.log(`  [${event.role.toLowerCase()}] ${event.message}`);
            return;
          case 'turnStart':
            console.log(`\n${'-'.repeat(64)}\nRound ${event.round} - ${event.role}\n${'-'.repeat(64)}`);
            return;
          case 'delta':
            process.stdout.write(event.delta);
            midLine = !event.delta.endsWith('\n');
            return;
          case 'toolStart':
            lineFeed();
            console.log(`  [tool ${event.tag} start] ${event.title}`);
            return;
          case 'toolEnd':
            lineFeed();
            console.log(`  [tool ${event.tag} ${event.status} - ${event.chars} chars]`);
            return;
          case 'turnCompleted':
            lineFeed();
            console.log(`  (turn done: ${event.stopReason})`);
            return;
          case 'turnFailed':
            lineFeed();
            console.log(`  (turn failed: ${event.error})`);
            return;
          case 'turnEnd':
            lineFeed();
            return;
          case 'result': {
            const { approved, feedback, maxRounds, cwd } = event.result;
            console.log('\n' + '='.repeat(64));
            if (approved) console.log(`Approved. Files under ${cwd}.`);
            else console.log(`Not approved after ${maxRounds} rounds.\nLast feedback:\n${feedback}`);
            return;
          }
          default:
            return;
        }
      });
    },
  };
}
