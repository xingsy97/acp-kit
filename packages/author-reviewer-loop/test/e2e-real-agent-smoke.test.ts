import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Optional, real-agent smoke coverage. These tests launch the real Spar CLI
// against real ACP agents (Codex, Claude Code, ...), so they are gated behind
// SPAR_REAL_AGENT_E2E=1 and skipped by default. This keeps the fast fake-ACP
// suite unaffected while still letting maintainers verify real integrations
// before a release.
//
// Usage:
//   npm run build
//   SPAR_REAL_AGENT_E2E=1 npm test                       # default agent: codex
//   SPAR_REAL_AGENT_E2E=1 SPAR_REAL_AGENT_E2E_AGENTS=codex,claude npm test
//
// Extra knobs:
//   SPAR_REAL_AGENT_E2E_TIMEOUT_MS   per-agent run timeout (default 300000)
//   SPAR_REAL_AGENT_E2E_MAX_ROUNDS   MAX_ROUNDS for the run (default 3)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sparBin = path.join(repoRoot, 'packages/author-reviewer-loop/bin/acp-author-reviewer-loop.mjs');

const enabled = process.env.SPAR_REAL_AGENT_E2E === '1';
const agents = (process.env.SPAR_REAL_AGENT_E2E_AGENTS ?? 'codex')
  .split(',')
  .map((agent) => agent.trim())
  .filter(Boolean);
const timeoutMs = Number(process.env.SPAR_REAL_AGENT_E2E_TIMEOUT_MS ?? 300_000);
const maxRounds = process.env.SPAR_REAL_AGENT_E2E_MAX_ROUNDS ?? '3';

const MARKER_NAME = 'spar-smoke.txt';
const MARKER_TEXT = 'SPAR_SMOKE_OK';
const TASK = `Create a file named ${MARKER_NAME} in the workspace root whose entire contents are exactly the text ${MARKER_TEXT} with no other text. Do not create any other files.`;

describe.skipIf(!enabled)('Spar real-agent smoke E2E (SPAR_REAL_AGENT_E2E=1)', () => {
  if (agents.length === 0) {
    it('requires at least one agent in SPAR_REAL_AGENT_E2E_AGENTS', () => {
      throw new Error(
        'SPAR_REAL_AGENT_E2E=1 but SPAR_REAL_AGENT_E2E_AGENTS resolved to an empty list. Set it to e.g. "codex" or "codex,claude".',
      );
    });
    return;
  }

  for (const agent of agents) {
    it(
      `${agent}: author writes a real file the reviewer approves`,
      async () => {
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `spar-real-${agent}-`));
        const workspace = path.join(tempRoot, 'workspace');
        await fs.mkdir(workspace, { recursive: true });
        const markerFile = path.join(workspace, MARKER_NAME);

        try {
          const result = await runNode(
            [sparBin, workspace, TASK, '--yes', '--cli', '--quality', 'dev'],
            {
              cwd: repoRoot,
              // Keep the real HOME so agent credentials/config resolve, but isolate
              // the workspace and disable update checks/recovery/trace/recording.
              env: {
                ...process.env,
                AUTHOR_AGENT: agent,
                REVIEWER_AGENT: agent,
                MAX_ROUNDS: maxRounds,
                SPAR_NO_UPDATE_CHECK: '1',
                SPAR_SESSION_RECORD: '0',
                SPAR_RUN_RECOVERY: '0',
                SPAR_RUN_TRACE: '0',
              },
              timeoutMs,
            },
          );

          expect(result.exitCode, result.stderr || result.stdout).toBe(0);
          const contents = await fs.readFile(markerFile, 'utf8');
          expect(contents.trim()).toContain(MARKER_TEXT);
        } finally {
          await fs.rm(tempRoot, { recursive: true, force: true });
        }
      },
      timeoutMs + 30_000,
    );
  }
});

function runNode(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out after ${options.timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}
