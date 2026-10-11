import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
const require = createRequire(import.meta.url);
const { resolveRepositoryLaunch } = require('../main/repository-launch.cjs');
const options = { repositoryPathProvided: true, walkthrough: false };
test('a failed remote open releases its lease and never uses a local repository', async () => {
  let releases = 0;
  let locals = 0;
  const localHost = {
    id: 'local',
    exec: () => {
      locals++;
      throw new Error('local');
    },
  };
  const registry = {
    acquire: async () => ({
      host: {
        label: 'devbox',
        exec: async () => {
          throw new Error('remote path missing');
        },
      },
      release: async () => {
        releases++;
      },
    }),
  };
  await expect(
    resolveRepositoryLaunch({ registry, localHost }, 'devbox:/remote/app', options),
  ).rejects.toThrow('remote path missing');
  expect(releases).toBe(1);
  expect(locals).toBe(0);
});
test('local-only launch workflows are rejected before remote acquisition', async () => {
  let acquires = 0;
  const context = {
    localHost: { id: 'local' },
    registry: {
      acquire: () => {
        acquires++;
        throw new Error('unexpected');
      },
    },
  };
  for (const extra of [
    { planFile: '/local/plan.md' },
    { source: { type: 'pull-request', url: 'https://github.com/a/b/pull/1' } },
  ]) {
    await expect(
      resolveRepositoryLaunch(context, 'devbox:/app', { ...options, ...extra }),
    ).rejects.toThrow(/unavailable|not available/);
  }
  expect(acquires).toBe(0);
});

test('remote walkthrough launches retain local context and file options', async () => {
  let released = false;
  const context = {
    localHost: { id: 'local' },
    registry: {
      acquire: async () => ({
        host: {
          id: 'ssh://devbox',
          exec: async () => Buffer.from('/remote/repo\n'),
          realpath: async (path: string) => path,
        },
        release: async () => {
          released = true;
        },
      }),
    },
  };
  const extra = {
    ...options,
    walkthrough: true,
    walkthroughFile: '/local/walkthrough.json',
    walkthroughContext: { version: 1, summary: 'local supplied' },
  };
  const result = await resolveRepositoryLaunch(context, 'devbox:/repo', extra);
  expect(result.launchOptions).toMatchObject(extra);
  expect(result.repositoryPath).toBe('/remote/repo');
  await result.release();
  expect(released).toBe(true);
});
