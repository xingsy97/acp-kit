import {
  ClaudeCode,
  CodexCli,
  GeminiCli,
  GitHubCopilot,
  OpenCode,
  QwenCode,
} from '@acp-kit/core';

export const agents = {
  claude: ClaudeCode,
  codex: CodexCli,
  copilot: GitHubCopilot,
  gemini: GeminiCli,
  opencode: OpenCode,
  qwen: QwenCode,
};

export const defaults = {
  authorAgent: 'copilot',
  authorModel: 'claude-opus-4.7',
  reviewerAgent: 'codex',
  reviewerModel: 'gpt-5.5',
  maxRounds: 10,
};
