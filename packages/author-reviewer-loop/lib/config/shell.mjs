import process from 'node:process';

export function formatEnvAssignment(name, value, options = {}) {
  const shell = detectShell(options);
  if (shell === 'powershell') return `$Env:${name}=${quotePowerShell(value)}`;
  return `export ${name}=${quotePosix(value)}`;
}

function detectShell({ env = process.env, platform = process.platform } = {}) {
  const shell = `${env.SHELL || ''} ${env.ComSpec || ''} ${env.TERM_PROGRAM || ''}`.toLowerCase();
  if (shell.includes('pwsh') || shell.includes('powershell')) return 'powershell';
  if (shell.includes('bash') || shell.includes('zsh') || shell.includes('/sh') || env.MSYSTEM) return 'posix';
  return platform === 'win32' ? 'powershell' : 'posix';
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quotePosix(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}