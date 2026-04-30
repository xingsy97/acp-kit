#!/usr/bin/env node
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRunConfig } from '../lib/cli/config.mjs';
import { printRunSummary } from '../lib/cli/summary.mjs';
import { confirmRun } from '../lib/cli/confirm.mjs';
import { createLoopEngine } from '../lib/engine.mjs';
import { createPlainRenderer } from '../lib/renderers/plain.mjs';
import { reportError } from '../lib/cli/error.mjs';
import { runUpdateCheck } from '../lib/cli/update-check.mjs';
import { createStartupProfiler } from '../lib/runtime/startup-profile.mjs';
import { detectInstalledAgents } from '@acp-kit/core';

try {
  const config = parseRunConfig();
  const previousTuiActive = process.env.ACP_TUI_ACTIVE;
  if (config.tui) process.env.ACP_TUI_ACTIVE = '1';
  try {
    const startupProfiler = createStartupProfiler({ scope: config.tui ? 'tui-startup' : 'cli-startup' });

    // Best-effort: nudge the user to update if a newer @acp-kit/spar release
    // is on npm. Only runs in interactive terminals; never blocks startup
    // when the registry is unreachable. In TUI mode we still run this BEFORE
    // taking over the screen so the prompt can use ordinary stdio.
    const updateOutcome = await maybeRunUpdateCheck();
    if (updateOutcome === 'updated') process.exit(0);

    if (config.tui) {
      startupProfiler.mark({ phase: 'tui startup begin', detail: { cwd: config.cwd } });
      // TUI mode owns the screen end-to-end: the run summary is shown inside
      // the TUI header and setup/confirmation are in-TUI overlays, so we must
      // NOT print to stdout or read from stdin via readline before launching it.
      const { runTui } = await import('../lib/renderers/tui.mjs');
      process.exitCode = await runTui({ config });
    } else {
      ensureConfiguredAgentsAvailable(config, startupProfiler);
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
  } finally {
    if (config.tui) {
      if (previousTuiActive == null) delete process.env.ACP_TUI_ACTIVE;
      else process.env.ACP_TUI_ACTIVE = previousTuiActive;
    }
  }
} catch (error) {
  reportError(error);
  process.exitCode = 1;
}

async function maybeRunUpdateCheck() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return await runUpdateCheck({ currentVersion: pkg?.version });
  } catch {
    return 'skipped';
  }
}

function ensureConfiguredAgentsAvailable(config, startupProfiler) {
  if (!config.authorSettings.agent || !config.reviewerSettings.agent) {
    throw createConfigurationError('AUTHOR_AGENT and REVIEWER_AGENT are required in --cli mode.');
  }

  // Pre-flight: ensure the configured agents are actually launchable.
  const agentsToCheck = [config.authorSettings.agent, config.reviewerSettings.agent];
  const unique = [...new Map(agentsToCheck.map((a) => [a.id, a])).values()];
  startupProfiler?.mark({ phase: 'agent detection begin', detail: { mode: 'cli', agentCount: unique.length } });
  const missing = detectInstalledAgents(unique).filter((r) => !r.installed);
  startupProfiler?.mark({
    phase: 'agent detection end',
    detail: { mode: 'cli', missing: missing.map(({ agent }) => agent.id) },
  });
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
