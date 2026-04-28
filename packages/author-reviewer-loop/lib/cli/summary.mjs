export function formatRunSummary({ cwd, task, taskSource, authorSettings, reviewerSettings, maxRounds, trace, tui }) {
  return `Run configuration
  cwd:            ${cwd}
  task source:    ${taskSource?.kind === 'file' ? taskSource.path : '(inline text)'}
  task:           ${task}
  author:         ${formatAgent(authorSettings)}
  author model:   ${authorSettings.model || '(agent default)'}
  reviewer:       ${formatAgent(reviewerSettings)}
  reviewer model: ${reviewerSettings.model || '(agent default)'}
  max rounds:     ${maxRounds}
  trace:          ${trace ? 'enabled' : 'disabled'}
  renderer:       ${tui ? 'tui (ink)' : 'plain'}
`;
}

function formatAgent(settings) {
  if (!settings.agent) return '(choose in TUI)';
  return `${settings.agent.displayName} (${settings.agent.id})`;
}

export function printRunSummary(config) {
  console.log(formatRunSummary(config));
}
