import { chmod, lstat, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { createRecordingHost } from '../../core/__tests__/helpers/recording-host.ts';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type {
  RepositoryFileDocument,
  SaveRepositoryFileRequest,
  SaveRepositoryFileResult,
} from '../../core/types.ts';
import type { RepositoryHost } from '../host/repository-host.cjs';

const require = createRequire(import.meta.url);
const { createLocalHost } = require('../host/local-host.cjs') as {
  createLocalHost: () => RepositoryHost;
};
const host = createLocalHost();
const { readRepositoryFile, writeRepositoryFile } = require('../repository-file.cjs') as {
  readRepositoryFile: (
    host: RepositoryHost,
    root: string,
    path: string,
  ) => Promise<RepositoryFileDocument>;
  writeRepositoryFile: (
    host: RepositoryHost,
    root: string,
    request: SaveRepositoryFileRequest,
  ) => Promise<SaveRepositoryFileResult>;
};

test('saves UTF-8 source without changing line endings, BOM, or executable permissions', async () => {
  await using directory = await createTemporaryDirectory('codiff-edit-');
  const path = join(directory.path, 'script.ts');
  await writeFile(path, '\uFEFFconst greeting = "こんにちは";\r\n');
  await chmod(path, 0o755);
  const document = await readRepositoryFile(host, directory.path, 'script.ts');
  const content = document.content.replace('こんにちは', 'こんばんは');
  const result = await writeRepositoryFile(host, directory.path, {
    ...document,
    baseVersion: document.version,
    content,
  });
  expect(result.status).toBe('saved');
  expect(await readFile(path, 'utf8')).toBe(content);
  expect(result.document.version).not.toBe(document.version);
  expect((await stat(path)).mode & 0o777).toBe(0o755);
});

test('keeps external edits and rejects saves belonging to a different repository', async () => {
  await using directory = await createTemporaryDirectory('codiff-edit-conflict-');
  const path = join(directory.path, 'source.ts');
  await writeFile(path, 'original\n');
  const document = await readRepositoryFile(host, directory.path, 'source.ts');
  await writeFile(path, 'external\n');
  const result = await writeRepositoryFile(host, directory.path, {
    ...document,
    baseVersion: document.version,
    content: 'draft\n',
  });
  expect(result).toMatchObject({ status: 'conflict', document: { content: 'external\n' } });
  expect(await readFile(path, 'utf8')).toBe('external\n');
  await expect(
    writeRepositoryFile(host, directory.path, {
      ...document,
      root: '/different-repository',
      baseVersion: document.version,
      content: 'draft\n',
    }),
  ).rejects.toThrow('different repository');
});

test('writes through contained symlinks but rejects traversal, outside targets, and Git metadata', async () => {
  await using directory = await createTemporaryDirectory('codiff-edit-path-');
  await using outside = await createTemporaryDirectory('codiff-edit-outside-');
  await writeFile(join(directory.path, 'target.ts'), 'original\n');
  await symlink('target.ts', join(directory.path, 'source.ts'));
  await symlink(outside.path, join(directory.path, 'outside'));
  await writeFile(join(outside.path, 'target.ts'), 'outside\n');
  await writeFile(join(directory.path, '.git'), 'gitdir: somewhere\n');
  const document = await readRepositoryFile(host, directory.path, 'source.ts');
  await writeRepositoryFile(host, directory.path, {
    ...document,
    baseVersion: document.version,
    content: 'updated\n',
  });
  expect((await lstat(join(directory.path, 'source.ts'))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(directory.path, 'target.ts'), 'utf8')).toBe('updated\n');
  await expect(readRepositoryFile(host, directory.path, 'outside/target.ts')).rejects.toThrow(
    'escapes',
  );
  await expect(readRepositoryFile(host, directory.path, '../outside/target.ts')).rejects.toThrow();
  await expect(readRepositoryFile(host, directory.path, '.git')).rejects.toThrow('Git metadata');
  expect(await readFile(join(outside.path, 'target.ts'), 'utf8')).toBe('outside\n');
});

test('refuses binary, non-UTF-8, and oversized files without rewriting them', async () => {
  await using directory = await createTemporaryDirectory('codiff-edit-binary-');
  for (const bytes of [
    Buffer.from([0, 1, 2]),
    Buffer.from([0xff]),
    Buffer.alloc(2 * 1024 * 1024 + 1, 97),
  ]) {
    const path = join(directory.path, 'data');
    await writeFile(path, bytes);
    await expect(readRepositoryFile(host, directory.path, 'data')).rejects.toThrow();
    expect((await readFile(path)).equals(bytes)).toBe(true);
  }
});

test('saves edited files through the host with an atomic rename', async () => {
  await using directory = await createTemporaryDirectory('codiff-repository-file-host-');
  const root = await realpath(directory.path);
  await writeFile(join(root, 'a.txt'), 'before\n');
  await chmod(join(root, 'a.txt'), 0o755);
  const { calls, host: recordingHost } = createRecordingHost(host);

  const current = await readRepositoryFile(recordingHost, root, 'a.txt');
  const result = await writeRepositoryFile(recordingHost, root, {
    baseVersion: current.version,
    content: 'after\n',
    path: 'a.txt',
    root: current.root,
  });

  expect(result.status).toBe('saved');
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('after\n');
  expect((await stat(join(root, 'a.txt'))).mode & 0o777).toBe(0o755);
  const write = calls.find(({ method }) => method === 'writeFile');
  expect(write?.args[2]).toEqual({ exclusive: true, mode: 0o755 });
  expect(calls.some(({ method }) => method === 'rename')).toBe(true);
});
