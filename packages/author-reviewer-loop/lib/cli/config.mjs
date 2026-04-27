import path from 'node:path';
import { Command } from 'commander';
import { agents, defaults } from '../config/agents.mjs';
import { env, envChoice, envFlag, envPositiveInt } from './env.mjs';

export function parseRunConfig({ argv } = {}) {
  let parsedArgs;
  const program = new Command()
    .name('author-reviewer-loop')
    .description('Run split-context AUTHOR and REVIEWER ACP agents over one workspace.')
    .usage('<cwd> <task...> [--yes] [--tui]')
    .argument('<cwd>', 'workspace directory')
    .argument('<task...>', 'task for the AUTHOR to implement')
    .option('-y, --yes', 'skip confirmation prompt')
    .option('--tui', 'use the experimental Ink TUI renderer')
    .addHelpText('after', `
Environment:
  AUTHOR_AGENT=copilot|claude|codex|gemini|qwen|opencode   default: ${defaults.authorAgent}
  AUTHOR_MODEL=<model-id>                                  default: ${defaults.authorModel}
  REVIEWER_AGENT=copilot|claude|codex|gemini|qwen|opencode default: ${defaults.reviewerAgent}
  REVIEWER_MODEL=<model-id>                                default: ${defaults.reviewerModel}
  MAX_ROUNDS=<n>                                            default: ${defaults.maxRounds}
  ACP_REVIEW_YES=1                                          skip confirmation prompt
  ACP_REVIEW_TUI=1                                          use the experimental Ink TUI renderer
  ACP_REVIEW_TRACE=1                                        print inspector trace on startup failures
`)
    .action((cwdArg, taskParts) => {
      parsedArgs = { cwdArg, taskParts };
    });

  if (argv) program.parse(argv, { from: 'user' });
  else program.parse();

  const cwd = path.resolve(parsedArgs.cwdArg);
  const task = parsedArgs.taskParts.join(' ').trim();
  const opts = program.opts();

  return {
    cwd,
    task,
    maxRounds: envPositiveInt('MAX_ROUNDS', defaults.maxRounds),
    trace: envFlag('ACP_REVIEW_TRACE'),
    skipConfirm: Boolean(opts.yes) || envFlag('ACP_REVIEW_YES'),
    tui: Boolean(opts.tui) || envFlag('ACP_REVIEW_TUI'),
    authorSettings: {
      agent: envChoice('AUTHOR_AGENT', agents, defaults.authorAgent),
      model: env('AUTHOR_MODEL', defaults.authorModel, { empty: null }),
      modelEnvName: 'AUTHOR_MODEL',
      prompt: ({ round, feedback }) => round === 1
        ? `You are the AUTHOR. Working dir: ${cwd}\n\nTask: ${task}\n\n`
          + 'Use your filesystem tools to create or modify files on disk. Do not paste code.'
        : `REVIEWER feedback:\n${feedback}\n\nUpdate the files in ${cwd} to address every point.`,
    },
    reviewerSettings: {
      agent: envChoice('REVIEWER_AGENT', agents, defaults.reviewerAgent),
      model: env('REVIEWER_MODEL', defaults.reviewerModel, { empty: null }),
      modelEnvName: 'REVIEWER_MODEL',
      prompt: () =>
        `You are the REVIEWER. Original task: ${task}\n\n`
        + `Inspect the project under ${cwd} using your filesystem tools. `
        + 'Reply APPROVED on its own line if it fully solves the task with no obvious bugs; '
        + 'otherwise reply with a terse numbered list of issues.',
    },
  };
}
