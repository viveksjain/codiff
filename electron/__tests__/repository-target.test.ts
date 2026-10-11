import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import type { RepositoryHost } from '../host/repository-host.cjs';
const require = createRequire(import.meta.url);
const {
  parseRepositoryTarget,
  resolveRemoteRepository,
  resolveRemoteSource,
} = require('../host/repository-target.cjs');

test('remote targets preserve path bytes and destination identity', () => {
  expect(parseRepositoryTarget('devbox:~/src/app', { exists: () => false })).toEqual({
    alias: 'devbox',
    path: '~/src/app',
    hostId: 'ssh://devbox',
  });
  expect(parseRepositoryTarget('ssh://me@devbox:2222/srv/a%20b')).toEqual({
    alias: 'me@devbox',
    port: 2222,
    path: '/srv/a b',
    hostId: 'ssh://me@devbox:2222',
  });
  expect(parseRepositoryTarget('ssh://[::1]:2222/srv/app')).toMatchObject({
    alias: '::1',
    port: 2222,
    hostId: 'ssh://[::1]:2222',
  });
});
test('existing and explicitly relative local colon paths stay local', () => {
  expect(parseRepositoryTarget('weird:name', { exists: () => true })).toBeNull();
  expect(parseRepositoryTarget('./weird:name')).toBeNull();
  expect(parseRepositoryTarget('/srv/weird:name')).toBeNull();
  expect(parseRepositoryTarget('ssh://devbox/srv/app', { exists: () => true })).not.toBeNull();
});
test('rejects malformed or unsafe remote destinations', () => {
  for (const value of [
    'ssh://-oProxyCommand=evil/app',
    'ssh://user:secret@host/app',
    'ssh://host:0/app',
    'ssh://host/app?x=y',
    'ssh://host/app#fragment',
    'ssh://host',
    'devbox:relative',
    'devbox:~other/app',
    '-host:/app',
  ]) {
    expect(() => parseRepositoryTarget(value, { exists: () => false })).toThrow();
  }
});
test('resolves HOME and Git toplevel on the chosen host', async () => {
  const calls: Array<unknown> = [];
  const host = {
    exec: async (command: string, args: Array<string>, options: { cwd?: string }) => {
      calls.push({ command, args, cwd: options?.cwd });
      return Buffer.from(command === 'git' ? '/home/a b/src/app\n' : '/home/a b');
    },
    realpath: async (path: string) => path,
  } as RepositoryHost;
  expect(await resolveRemoteRepository(host, '~/src/app/subdir')).toBe('/home/a b/src/app');
  expect(calls).toContainEqual({
    command: 'git',
    args: ['rev-parse', '--show-toplevel'],
    cwd: '/home/a b/src/app/subdir',
  });
  await expect(resolveRemoteRepository(host, 'relative')).rejects.toThrow(/absolute|~/);
});
test('classifies remote refs against the remote repository', async () => {
  const host = {
    exec: async (_command: string, args: Array<string>, options: { cwd: string }) => {
      expect(options.cwd).toBe('/remote/repo');
      if (
        args.includes('refs/heads/feature') ||
        args.includes('HEAD^{commit}') ||
        args.includes('v1^{commit}')
      ) {
        return Buffer.from('commit\n');
      }
      throw new Error('not a ref');
    },
  } as RepositoryHost;
  expect(await resolveRemoteSource(host, '/remote/repo', { candidate: 'feature' })).toEqual({
    ref: 'feature',
    type: 'branch-working-tree',
  });
  expect(await resolveRemoteSource(host, '/remote/repo', { candidate: 'HEAD' })).toEqual({
    ref: 'HEAD',
    type: 'commit',
  });
  expect(
    await resolveRemoteSource(host, '/remote/repo', {
      range: { base: 'v1', head: 'HEAD', symmetric: true },
    }),
  ).toEqual({ base: 'v1', head: 'HEAD', symmetric: true, type: 'range' });
  await expect(
    resolveRemoteSource(host, '/remote/repo', {
      range: { base: 'missing', head: 'HEAD', symmetric: false },
    }),
  ).rejects.toThrow(/missing/);
});
