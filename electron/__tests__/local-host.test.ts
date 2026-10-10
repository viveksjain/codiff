import { realpathSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type { RepositoryHost } from '../host/repository-host.cjs';
import { defineRepositoryHostContract } from './helpers/repository-host-contract.ts';

const require = createRequire(import.meta.url);
const { createLocalHost } = require('../host/local-host.cjs') as {
  createLocalHost: () => RepositoryHost;
};

defineRepositoryHostContract('LocalHost', async () => {
  const directory = await createTemporaryDirectory('codiff-local-host-');
  return {
    host: createLocalHost(),
    root: directory.path,
    [Symbol.asyncDispose]: () => directory[Symbol.asyncDispose](),
  };
});

test('LocalHost identifies itself as local', () => {
  const host = createLocalHost();
  expect(host.id).toBe('local');
  expect(host.label).toBe('');
});

test('LocalHost keeps the execFile error message for commands without input', async () => {
  // Git failure messages reach users (for example as commit failure reasons),
  // so they must stay byte-identical to the pre-host implementation.
  await expect(createLocalHost().exec('git', ['-C', '/', 'no-such-command'])).rejects.toThrow(
    /^Command failed: git -C \/ no-such-command/,
  );
});

test('LocalHost reads the process environment at call time', async () => {
  const host = createLocalHost();
  process.env.CODIFF_LOCAL_HOST_LATE = 'late';
  try {
    const output = await host.exec('/bin/sh', ['-c', 'printf %s "$CODIFF_LOCAL_HOST_LATE"']);
    expect(output.toString('utf8')).toBe('late');
  } finally {
    delete process.env.CODIFF_LOCAL_HOST_LATE;
  }
});

test('LocalHost.realpath matches the synchronous JS realpath through a symlink', async () => {
  await using directory = await createTemporaryDirectory('codiff-local-host-realpath-');
  const target = join(directory.path, 'target');
  const link = join(directory.path, 'link');
  await mkdir(target);
  await symlink(target, link);
  expect(await createLocalHost().realpath(link)).toBe(realpathSync(link));
});
