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

test('missing window context fails instead of falling back to local execution', () => {
  const repositories = createWindowRepositories({ getLaunchPath: () => '/local', localHost });
  expect(() => repositories.get(1)).toThrow(/context/);
  repositories.set(7, { host: otherHost, repositoryPath: '/srv/app' });
  expect(repositories.get(7)).toEqual({ host: otherHost, repositoryPath: '/srv/app' });
  repositories.delete(7);
  expect(() => repositories.get(7)).toThrow(/context/);
});
