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
  /** Extra environment variables merged on top of `process.env`. */
  env?: Record<string, string>;
  /** Override the default 30s startup timeout (initialize / newSession / loadSession). */
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
 * Launches `npx @github/copilot-language-server@latest --acp`.
 */
export const GitHubCopilot: AgentProfile = {
  id: 'github-copilot',
  displayName: 'GitHub Copilot',
  command: 'npx',
  args: ['@github/copilot-language-server@latest', '--acp'],
  startupTimeoutMs: 90000,
};

/**
 * Anthropic Claude Code via the Zed-maintained ACP wrapper.
 *
 * Launches `npx @zed-industries/claude-code-acp@latest`.
 */
export const ClaudeCode: AgentProfile = {
  id: 'claude-code',
  displayName: 'Claude Code',
  command: 'npx',
  args: ['@zed-industries/claude-code-acp@latest'],
  startupTimeoutMs: 90000,
};

/**
 * OpenAI Codex CLI via the Zed-maintained ACP wrapper.
 *
 * Launches `npx @zed-industries/codex-acp@latest`.
 */
export const CodexCli: AgentProfile = {
  id: 'codex-cli',
  displayName: 'Codex CLI',
  command: 'npx',
  args: ['@zed-industries/codex-acp@latest'],
  startupTimeoutMs: 90000,
};

/**
 * Google Gemini CLI in experimental ACP mode.
 *
 * Launches `npx @google/gemini-cli@latest --experimental-acp`.
 */
export const GeminiCli: AgentProfile = {
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  command: 'npx',
  args: ['@google/gemini-cli@latest', '--experimental-acp'],
  startupTimeoutMs: 90000,
};

/**
 * Alibaba Qwen Code in ACP mode.
 *
 * Launches `npx @qwen-code/qwen-code@latest --acp --experimental-skills`.
 */
export const QwenCode: AgentProfile = {
  id: 'qwen-code',
  displayName: 'Qwen Code',
  command: 'npx',
  args: ['@qwen-code/qwen-code@latest', '--acp', '--experimental-skills'],
  startupTimeoutMs: 90000,
};

/**
 * OpenCode CLI in ACP mode.
 *
 * Launches `npx opencode-ai@latest acp`.
 */
export const OpenCode: AgentProfile = {
  id: 'opencode',
  displayName: 'OpenCode',
  command: 'npx',
  args: ['opencode-ai@latest', 'acp'],
  startupTimeoutMs: 90000,
};
