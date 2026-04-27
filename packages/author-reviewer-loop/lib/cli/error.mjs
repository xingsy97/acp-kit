import { formatStartupDiagnostics, isAcpStartupError } from '@acp-kit/core';

export function formatStartupError(error) {
  if (isAcpStartupError(error)) {
    return formatStartupDiagnostics(error.diagnostics);
  }
  if (error instanceof Error && error.name === 'ConfigurationError') {
    return `Error: ${error.message}`;
  }
  return error instanceof Error ? error.stack || error.message : String(error);
}

export function reportError(error) {
  console.error(formatStartupError(error));
}
