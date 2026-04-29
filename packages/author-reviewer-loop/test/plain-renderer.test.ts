import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlainRenderer } from '../lib/renderers/plain.mjs';

describe('plain renderer', () => {
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalIsTTY });
    vi.restoreAllMocks();
  });

  it('shows numbered thinking labels instead of exposing raw reasoning ids', () => {
    const writes: string[] = [];
    const logs: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ''));
    });

    const renderer = createPlainRenderer();
    let listener = (_event: unknown) => {};
    renderer.attach({
      onEvent(fn: (event: unknown) => void) {
        listener = fn;
        return () => {};
      },
    });

    listener({ type: 'reasoningDelta', role: 'AUTHOR', delta: 'Investigating', reasoningId: 'reasoning-session-1234567890' });
    listener({ type: 'reasoningCompleted', role: 'AUTHOR', reasoningId: 'reasoning-session-1234567890', content: 'Investigating' });
    listener({ type: 'reasoningCompleted', role: 'AUTHOR', reasoningId: 'reasoning-session-abcdef', content: 'Done' });

    expect(writes.join('')).toContain('[author thinking #1]');
    expect(logs).toContain('  [author thought #1] 13 chars');
    expect(logs).toContain('  [author thought #2] 4 chars');
    expect(writes.join('')).not.toContain('reasoning-session-1234567890');
    expect(logs.join('\n')).not.toContain('reasoning-session-1234567890');
  });
});
