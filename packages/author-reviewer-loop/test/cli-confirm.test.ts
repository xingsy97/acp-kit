import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createInterface: vi.fn(),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: mocks.createInterface,
}));

const { confirmRun } = await import('../lib/cli/confirm.mjs');

const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;

describe('CLI confirmation prompt', () => {
  beforeEach(() => {
    mocks.createInterface.mockReset();
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalStdinIsTTY });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalStdoutIsTTY });
  });

  it('asks the operator to start the run with the correct prompt text', async () => {
    const question = vi.fn().mockResolvedValue('y');
    const close = vi.fn();
    mocks.createInterface.mockReturnValue({ question, close });

    await expect(confirmRun()).resolves.toBe(true);

    expect(question).toHaveBeenCalledWith('Start run? [y/N] ');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the default answer as no when the operator submits an empty reply', async () => {
    const question = vi.fn().mockResolvedValue('');
    const close = vi.fn();
    mocks.createInterface.mockReturnValue({ question, close });

    await expect(confirmRun()).resolves.toBe(false);

    expect(question).toHaveBeenCalledWith('Start run? [y/N] ');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
