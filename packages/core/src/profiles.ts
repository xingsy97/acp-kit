export interface AgentProfile {
  id: string;
  displayName: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  startupTimeoutMs?: number;
  filterStdoutLine?: (line: string) => string | null;
}

export type BuiltInProfileId = 'copilot' | 'claude' | 'codex';

export const builtInProfiles: Record<BuiltInProfileId, AgentProfile> = {
  copilot: {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    command: 'npx',
    args: ['@github/copilot@latest', '--acp'],
    startupTimeoutMs: 90000,
  },
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    command: 'npx',
    args: ['@agentclientprotocol/claude-agent-acp@latest'],
    startupTimeoutMs: 90000,
  },
  codex: {
    id: 'codex',
    displayName: 'Codex CLI',
    command: 'npx',
    args: ['@zed-industries/codex-acp@latest'],
    startupTimeoutMs: 90000,
  },
};

export function resolveAgentProfile(profile: AgentProfile | BuiltInProfileId): AgentProfile {
  if (typeof profile !== 'string') {
    return {
      ...profile,
      args: [...profile.args],
      env: profile.env ? { ...profile.env } : undefined,
    };
  }

  const resolved = builtInProfiles[profile];
  if (!resolved) {
    throw new Error(`Unknown ACP profile: ${profile}`);
  }

  return {
    ...resolved,
    args: [...resolved.args],
    env: resolved.env ? { ...resolved.env } : undefined,
  };
}
