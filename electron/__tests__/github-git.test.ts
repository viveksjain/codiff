import { createRequire } from 'node:module';
import { expect, test, vi } from 'vite-plus/test';
import type { RepositoryHost } from '../host/repository-host.cjs';

const require = createRequire(import.meta.url);
const { git, gitOrEmpty } = require('../git-state/github-git.cjs') as {
  git: (host: RepositoryHost, root: string, args: string[]) => Promise<string>;
  gitOrEmpty: (host: RepositoryHost, root: string, args: string[]) => Promise<string>;
};

test.each([
  ['clone', 'https://github.com/acme/widgets.git'],
  ['fetch', 'origin'],
  ['show', 'missing:file.txt'],
  ['cat-file', '-p', 'missing'],
  ['ls-tree', 'missing'],
  ['read-tree', 'missing'],
  ['check-attr', '--source', 'missing', 'linguist-generated', 'file.txt'],
  ['merge-base', 'main', 'missing'],
  ['log', 'missing'],
  ['diff', 'main', 'missing'],
  ['rev-parse', '--verify', 'missing^{commit}'],
  ['-c', 'alias.read=!git fetch origin', 'read'],
])('rejects Git %s before it can run for a GitHub review', async (...args) => {
  const exec = vi.fn(async () => Buffer.from(''));
  const host = { exec } as unknown as RepositoryHost;
  await expect(git(host, '/repo', args)).rejects.toThrow(
    'GitHub reviews only read Git repository metadata',
  );
  await expect(gitOrEmpty(host, '/repo', args)).rejects.toThrow(
    'GitHub reviews only read Git repository metadata',
  );
  expect(exec).not.toHaveBeenCalled();
});

test.each([
  ['rev-parse', '--show-toplevel'],
  ['remote'],
  ['config', '--get', 'remote.origin.url'],
  ['symbolic-ref', '--short', 'HEAD'],
  ['ls-remote', '--refs', 'origin', 'refs/pull/42/head'],
])('permits Git %s metadata while explicitly disabling lazy fetches', async (...args) => {
  const exec = vi.fn(async () => Buffer.from('metadata'));
  const host = { exec } as unknown as RepositoryHost;
  expect(await git(host, '/repo', args)).toBe('metadata');
  expect(exec).toHaveBeenCalledWith(
    'git',
    ['-C', '/repo', ...args],
    expect.objectContaining({ env: { GIT_NO_LAZY_FETCH: '1' } }),
  );
});
