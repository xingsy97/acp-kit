/**
 * Agent launch profile: everything ACP Kit needs to spawn an ACP-capable agent
 * and translate its stdout/stderr. The built-in constants below
 * ({@link GitHubCopilot}, {@link ClaudeCode}, ...) are the recommended way to
 * pick a known agent; for custom agents construct an `AgentProfile` literal.
 */
export interface AgentProfile {
  /** Stable identifier surfaced in errors and diagnostics. Free-form for custom agents. */
  id: string;
  /** Human-readable name. */
  displayName: string;
  /** Executable to spawn (e.g. `'npx'`). Resolved through `PATH`. */
  command: string;
  /** Argument vector passed to {@link AgentProfile.command}. */
  args: string[];
  /** Slower fallback launch commands, tried when the primary command is not on PATH. */
  fallbackCommands?: Array<{ command: string; args: string[] }>;
  /** Extra environment variables merged on top of `process.env`. */
  env?: Record<string, string>;
  /** Override the startup timeout (initialize / newSession / loadSession). */
  startupTimeoutMs?: number;
  /**
   * Optional per-line filter applied to the agent's stdout before JSON-RPC parsing.
   * Return `null` to drop a line (useful for agents that emit chatty banners on
   * the same channel as the protocol).
   */
  filterStdoutLine?: (line: string) => string | null;
}

/**
 * GitHub Copilot in ACP mode.
 *
 * Launches `copilot-language-server --acp`.
 */
export const GitHubCopilot: AgentProfile = {
  id: 'github-copilot',
  displayName: 'GitHub Copilot',
  command: 'copilot-language-server',
  args: ['--acp'],
  fallbackCommands: [{ command: 'npx', args: ['--yes', '@github/copilot-language-server@latest', '--acp'] }],
  startupTimeoutMs: 90000,
};

/**
 * Anthropic Claude Code via the Zed-maintained ACP wrapper.
 *
 * Launches `claude-code-acp`.
 */
export const ClaudeCode: AgentProfile = {
  id: 'claude-code',
  displayName: 'Claude Code',
  command: 'claude-code-acp',
  args: [],
  fallbackCommands: [{ command: 'npx', args: ['--yes', '@zed-industries/claude-code-acp@latest'] }],
  startupTimeoutMs: 90000,
};

/**
 * OpenAI Codex CLI via the Zed-maintained ACP wrapper.
 *
 * Launches `codex-acp`.
 */
export const CodexCli: AgentProfile = {
  id: 'codex-cli',
  displayName: 'Codex CLI',
  command: 'codex-acp',
  args: [],
  fallbackCommands: [{ command: 'npx', args: ['--yes', '@zed-industries/codex-acp@latest'] }],
  startupTimeoutMs: 90000,
};

/**
 * Google Gemini CLI in experimental ACP mode.
 *
 * Launches `gemini --experimental-acp`.
 */
export const GeminiCli: AgentProfile = {
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  command: 'gemini',
  args: ['--experimental-acp'],
  fallbackCommands: [{ command: 'npx', args: ['--yes', '@google/gemini-cli@latest', '--experimental-acp'] }],
  startupTimeoutMs: 90000,
};

/**
 * Alibaba Qwen Code in ACP mode.
 *
 * Launches `qwen --acp --experimental-skills`.
 */
export const QwenCode: AgentProfile = {
  id: 'qwen-code',
  displayName: 'Qwen Code',
  command: 'qwen',
  args: ['--acp', '--experimental-skills'],
  fallbackCommands: [{ command: 'npx', args: ['--yes', '@qwen-code/qwen-code@latest', '--acp', '--experimental-skills'] }],
  startupTimeoutMs: 90000,
};

/**
 * OpenCode CLI in ACP mode.
 *
 * Launches `opencode acp`.
 */
export const OpenCode: AgentProfile = {
  id: 'opencode',
  displayName: 'OpenCode',
  command: 'opencode',
  args: ['acp'],
  fallbackCommands: [{ command: 'npx', args: ['--yes', 'opencode-ai@latest', 'acp'] }],
  startupTimeoutMs: 90000,
};
