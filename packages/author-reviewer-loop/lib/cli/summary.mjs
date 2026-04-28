export function formatRunSummary({ cwd, task, taskSource, authorSettings, reviewerSettings, maxRounds, trace, tui }) {
  return `Run configuration
  cwd:            ${cwd}
  task source:    ${taskSource?.kind === 'file' ? taskSource.path : '(inline text)'}
  task:           ${task}
  author:         ${authorSettings.agent.displayName} (${authorSettings.agent.id})
  author model:   ${authorSettings.model || '(agent default)'}
  reviewer:       ${reviewerSettings.agent.displayName} (${reviewerSettings.agent.id})
  reviewer model: ${reviewerSettings.model || '(agent default)'}
  max rounds:     ${maxRounds}
  trace:          ${trace ? 'enabled' : 'disabled'}
  renderer:       ${tui ? 'tui (ink)' : 'plain'}
`;
}

export function printRunSummary(config) {
  console.log(formatRunSummary(config));
}
