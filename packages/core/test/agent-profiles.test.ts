import { describe, expect, it } from 'vitest';

import {
  ClaudeCode,
  CodexCli,
  GeminiCli,
  GitHubCopilot,
  OpenCode,
  QwenCode,
  type AgentProfile,
} from '../src/index.js';

const allAgents: Array<[string, AgentProfile]> = [
  ['ClaudeCode', ClaudeCode],
  ['GitHubCopilot', GitHubCopilot],
  ['CodexCli', CodexCli],
  ['GeminiCli', GeminiCli],
  ['QwenCode', QwenCode],
  ['OpenCode', OpenCode],
];

describe('built-in agent profiles', () => {
  it.each(allAgents)('%s has all required fields', (_name, agent) => {
    expect(typeof agent.id).toBe('string');
    expect(agent.id.length).toBeGreaterThan(0);
    expect(typeof agent.displayName).toBe('string');
    expect(agent.displayName.length).toBeGreaterThan(0);
    expect(typeof agent.command).toBe('string');
    expect(agent.command.length).toBeGreaterThan(0);
    expect(Array.isArray(agent.args)).toBe(true);
  });

  it.each(allAgents)('%s has a startupTimeoutMs of 90000', (_name, agent) => {
    expect(agent.startupTimeoutMs).toBe(90000);
  });

  it.each(allAgents)('%s has fallbackCommands', (_name, agent) => {
    expect(Array.isArray(agent.fallbackCommands)).toBe(true);
    expect(agent.fallbackCommands!.length).toBeGreaterThan(0);
    for (const fallback of agent.fallbackCommands!) {
      expect(typeof fallback.command).toBe('string');
      expect(Array.isArray(fallback.args)).toBe(true);
    }
  });

  it.each(allAgents)('%s has unique id', (_name, agent) => {
    const otherIds = allAgents.filter(([, a]) => a !== agent).map(([, a]) => a.id);
    expect(otherIds).not.toContain(agent.id);
  });

  it('ClaudeCode has correct command', () => {
    expect(ClaudeCode.command).toBe('claude-code-acp');
    expect(ClaudeCode.args).toEqual([]);
  });

  it('GitHubCopilot has correct command and args', () => {
    expect(GitHubCopilot.command).toBe('copilot-language-server');
    expect(GitHubCopilot.args).toEqual(['--acp']);
  });

  it('CodexCli has correct command', () => {
    expect(CodexCli.command).toBe('codex-acp');
    expect(CodexCli.args).toEqual([]);
  });

  it('GeminiCli has experimental ACP flag', () => {
    expect(GeminiCli.command).toBe('gemini');
    expect(GeminiCli.args).toContain('--experimental-acp');
  });

  it('QwenCode has ACP and experimental-skills flags', () => {
    expect(QwenCode.command).toBe('qwen');
    expect(QwenCode.args).toContain('--acp');
    expect(QwenCode.args).toContain('--experimental-skills');
  });

  it('OpenCode uses "acp" subcommand', () => {
    expect(OpenCode.command).toBe('opencode');
    expect(OpenCode.args).toEqual(['acp']);
  });

  it('built-in profiles do not have filterStdoutLine set', () => {
    for (const [, agent] of allAgents) {
      expect(agent.filterStdoutLine).toBeUndefined();
    }
  });

  it('spreading a profile does not mutate the original', () => {
    const original = { ...ClaudeCode };
    const custom = { ...ClaudeCode, startupTimeoutMs: 5000, env: { CUSTOM: '1' } };
    expect(ClaudeCode.startupTimeoutMs).toBe(original.startupTimeoutMs);
    expect(ClaudeCode.env).toBeUndefined();
    expect(custom.startupTimeoutMs).toBe(5000);
  });
});
