import type { AgentProfile } from './agents.js';
import {
  GitHubCopilot,
  ClaudeCode,
  CodexCli,
  GeminiCli,
  QwenCode,
  OpenCode,
} from './agents.js';
import { isCommandOnPath } from './command-exists.js';

/** All agents that ACP Kit officially supports. */
export const supportedAgents: readonly AgentProfile[] = [
  GitHubCopilot,
  ClaudeCode,
  CodexCli,
  GeminiCli,
  QwenCode,
  OpenCode,
];

export interface AgentDetectionResult {
  agent: AgentProfile;
  /** `true` when the primary command OR any fallback command resolves on PATH. */
  installed: boolean;
}

/**
 * Check whether an agent can be launched — mirrors the resolution logic in
 * `resolveAgentLaunch` (transports/node): the agent is considered installed
 * when its primary command **or** any of its `fallbackCommands` resolve on
 * PATH. Uses the same `isCommandOnPath` helper the runtime uses, which
 * handles absolute paths and Windows `PATHEXT`.
 *
 * No agent process is spawned, so this is both fast and side-effect free.
 */
function isAgentAvailable(agent: AgentProfile): boolean {
  if (isCommandOnPath(agent.command)) return true;
  for (const fallback of agent.fallbackCommands ?? []) {
    if (isCommandOnPath(fallback.command)) return true;
  }
  return false;
}

/**
 * Detect which of the officially-supported ACP agents are available locally.
 *
 * An agent is reported as installed when its primary command **or** any
 * fallback command (e.g. `npx`) is found on PATH — matching the runtime's
 * own launch resolution so no valid configuration is rejected.
 *
 * @param agents - Optional subset of agents to check. Defaults to all supported agents.
 * @returns One entry per agent with its `installed` status.
 *
 * ```ts
 * import { detectInstalledAgents } from '@acp-kit/core';
 *
 * const results = await detectInstalledAgents();
 * for (const { agent, installed } of results) {
 *   console.log(`${agent.displayName}: ${installed ? 'available' : 'not found'}`);
 * }
 * ```
 */
export function detectInstalledAgents(
  agents: readonly AgentProfile[] = supportedAgents,
): AgentDetectionResult[] {
  return agents.map((agent) => ({
    agent,
    installed: isAgentAvailable(agent),
  }));
}
