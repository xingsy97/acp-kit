#!/usr/bin/env node
import process from 'node:process';
import { parseRunConfig } from '../lib/cli/config.mjs';
import { printRunSummary } from '../lib/cli/summary.mjs';
import { confirmRun } from '../lib/cli/confirm.mjs';
import { createLoopEngine } from '../lib/engine.mjs';
import { createPlainRenderer } from '../lib/renderers/plain.mjs';
import { reportError } from '../lib/cli/error.mjs';

const config = parseRunConfig();

try {
  if (config.tui) {
    // TUI mode owns the screen end-to-end: the run summary is shown inside
    // the TUI header and confirmation is an in-TUI overlay, so we must NOT
    // print to stdout or read from stdin via readline before launching it.
    const { runTui } = await import('../lib/renderers/tui.mjs');
    process.exitCode = await runTui({ config });
  } else {
    printRunSummary(config);
    if (!config.skipConfirm && !(await confirmRun())) {
      console.log('Cancelled.');
      process.exit(1);
    }
    const engine = createLoopEngine({ config });
    createPlainRenderer().attach(engine);
    const result = await engine.run();
    process.exitCode = result.approved ? 0 : 1;
  }
} catch (error) {
  reportError(error);
  process.exitCode = 1;
}
