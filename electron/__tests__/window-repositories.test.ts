import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import type { RepositoryHost } from '../host/repository-host.cjs';

type WindowRepository = { host: RepositoryHost; repositoryPath: string };

const require = createRequire(import.meta.url);
const { createWindowRepositories } = require('../window-repositories.cjs') as {
  createWindowRepositories: (options: {
    getLaunchPath: () => string;
    localHost: RepositoryHost;
  }) => {
    delete: (id: number) => void;
    get: (id: number) => WindowRepository;
    set: (id: number, repository: WindowRepository) => void;
  };
};

const localHost = { id: 'local', label: '' } as RepositoryHost;
const otherHost = { id: 'other', label: 'other' } as RepositoryHost;

test('falls back to the local host and the current launch path', () => {
  let launchPath = '/first';
  const repositories = createWindowRepositories({ getLaunchPath: () => launchPath, localHost });
  expect(repositories.get(1)).toEqual({ host: localHost, repositoryPath: '/first' });
  launchPath = '/second';
  expect(repositories.get(1).repositoryPath).toBe('/second');
});

test('returns the stored host and path for a window until it is deleted', () => {
  const repositories = createWindowRepositories({ getLaunchPath: () => '/launch', localHost });
  repositories.set(7, { host: otherHost, repositoryPath: '/srv/app' });
  expect(repositories.get(7)).toEqual({ host: otherHost, repositoryPath: '/srv/app' });
  expect(repositories.get(8)).toEqual({ host: localHost, repositoryPath: '/launch' });
  repositories.delete(7);
  expect(repositories.get(7)).toEqual({ host: localHost, repositoryPath: '/launch' });
});
