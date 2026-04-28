#!/usr/bin/env node
import process from 'node:process';
import { parseRunConfig } from '../lib/cli/config.mjs';
import { printRunSummary } from '../lib/cli/summary.mjs';
import { confirmRun } from '../lib/cli/confirm.mjs';
import { createLoopEngine } from '../lib/engine.mjs';
import { createPlainRenderer } from '../lib/renderers/plain.mjs';
import { reportError } from '../lib/cli/error.mjs';
import { detectInstalledAgents } from '@acp-kit/core';

try {
  const config = parseRunConfig();

  if (config.tui) {
    // TUI mode owns the screen end-to-end: the run summary is shown inside
    // the TUI header and setup/confirmation are in-TUI overlays, so we must
    // NOT print to stdout or read from stdin via readline before launching it.
    const { runTui } = await import('../lib/renderers/tui.mjs');
    process.exitCode = await runTui({ config });
  } else {
    ensureConfiguredAgentsAvailable(config);
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

function ensureConfiguredAgentsAvailable(config) {
  if (!config.authorSettings.agent || !config.reviewerSettings.agent) {
    throw createConfigurationError('AUTHOR_AGENT and REVIEWER_AGENT are required in --cli mode.');
  }

  // Pre-flight: ensure the configured agents are actually launchable.
  const agentsToCheck = [config.authorSettings.agent, config.reviewerSettings.agent];
  const unique = [...new Map(agentsToCheck.map((a) => [a.id, a])).values()];
  const missing = detectInstalledAgents(unique).filter((r) => !r.installed);
  if (missing.length === 0) return;

  for (const { agent } of missing) {
    console.error(
      `Error: agent "${agent.displayName}" is not available - neither "${agent.command}" nor any fallback command was found on PATH.`,
    );
  }
  console.error(
    '\nInstall the missing agent(s) or choose a different agent via AUTHOR_AGENT / REVIEWER_AGENT env vars.',
  );
  process.exit(1);
}

function createConfigurationError(message) {
  const error = new Error(message);
  error.name = 'ConfigurationError';
  return error;
}
