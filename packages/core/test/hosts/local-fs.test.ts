import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalFileSystemHost } from '../../src/hosts/local-fs.js';

describe('createLocalFileSystemHost', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'acp-localfs-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a relative root', () => {
    expect(() => createLocalFileSystemHost({ root: 'relative/path' })).toThrow(/absolute/);
  });

  it('reads a file inside the sandbox', async () => {
    await writeFile(path.join(root, 'a.txt'), 'hello');
    const host = createLocalFileSystemHost({ root });
    const res = await host.readTextFile({ sessionId: 's', path: 'a.txt' });
    expect(res.content).toBe('hello');
  });

  it('supports line/limit slicing on read', async () => {
    await writeFile(path.join(root, 'lines.txt'), 'a\nb\nc\nd');
    const host = createLocalFileSystemHost({ root });
    const res = await host.readTextFile({ sessionId: 's', path: 'lines.txt', line: 2, limit: 2 });
    expect(res.content).toBe('b\nc');
  });

  it('writes a file and creates parent directories', async () => {
    const host = createLocalFileSystemHost({ root });
    await host.writeTextFile({ sessionId: 's', path: 'sub/dir/out.txt', content: 'x' });
    const written = await readFile(path.join(root, 'sub', 'dir', 'out.txt'), 'utf-8');
    expect(written).toBe('x');
  });

  it('rejects path traversal via ..', async () => {
    const host = createLocalFileSystemHost({ root });
    await expect(host.readTextFile({ sessionId: 's', path: '../escape.txt' })).rejects.toThrow(/escape/i);
  });

  it('rejects symlinks pointing outside the sandbox by default', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'acp-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'no');
      try {
        await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
      } catch (err) {
        // symlink may require admin on Windows; skip the test in that case.
        if ((err as NodeJS.ErrnoException)?.code === 'EPERM') return;
        throw err;
      }
      const host = createLocalFileSystemHost({ root });
      await expect(host.readTextFile({ sessionId: 's', path: 'link.txt' })).rejects.toThrow(/escape/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('invokes onAccess for read and write', async () => {
    await writeFile(path.join(root, 'r.txt'), 'r');
    const events: Array<{ op: string; relativePath: string }> = [];
    const host = createLocalFileSystemHost({
      root,
      onAccess: (e) => events.push({ op: e.op, relativePath: e.relativePath }),
    });
    await host.readTextFile({ sessionId: 's', path: 'r.txt' });
    await host.writeTextFile({ sessionId: 's', path: 'w.txt', content: 'w' });
    expect(events).toEqual([
      { op: 'read', relativePath: 'r.txt' },
      { op: 'write', relativePath: 'w.txt' },
    ]);
  });

  it('allows writing a fresh file whose leaf does not yet exist', async () => {
    await mkdir(path.join(root, 'nested'), { recursive: true });
    const host = createLocalFileSystemHost({ root });
    await host.writeTextFile({ sessionId: 's', path: 'nested/new.txt', content: 'k' });
    expect(await readFile(path.join(root, 'nested', 'new.txt'), 'utf-8')).toBe('k');
  });
});
