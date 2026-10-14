import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import type { RepositoryState } from '../../core/types.ts';

const require = createRequire(import.meta.url);
const { createRepositoryStateLoad } = require('../main/repository-state-load.cjs') as {
  createRepositoryStateLoad: (
    read: (report: (state: RepositoryState) => void) => Promise<RepositoryState>,
  ) => {
    promise: Promise<RepositoryState>;
    subscribe: (listener: (state: RepositoryState) => void) => () => void;
  };
};

test('a prefetched tracked snapshot is replayed to a late renderer only while discovery is pending', async () => {
  const tracked: RepositoryState = {
    branch: 'main',
    files: [],
    generatedAt: 1,
    launchPath: '/repo',
    root: '/repo',
    source: { type: 'working-tree' },
    untrackedLoading: true,
  };
  const complete = { ...tracked, untrackedLoading: false };
  const completion = Promise.withResolvers<RepositoryState>();
  const load = createRepositoryStateLoad(async (report) => {
    report(tracked);
    return completion.promise;
  });
  const updates: RepositoryState[] = [];
  const unsubscribe = load.subscribe((state) => updates.push(state));
  expect(updates).toEqual([tracked]);
  unsubscribe();
  completion.resolve(complete);
  expect(await load.promise).toEqual(complete);
  load.subscribe((state) => updates.push(state));
  expect(updates).toEqual([tracked]);
});
