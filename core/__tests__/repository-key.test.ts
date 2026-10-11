import { expect, test } from 'vite-plus/test';
import { getRepositoryStateKey } from '../lib/repository-key.ts';
const { getRepositoryKey } = createRequire(import.meta.url)(
  '../../electron/host/repository-identity.cjs',
);
test('browser and main process use the same repository identity', () => {
  for (const hostId of [undefined, 'local', 'ssh://first', 'ssh://[::1]:2222']) {
    for (const root of ['/srv/app', '/home/a b/project']) {
      expect(getRepositoryStateKey({ hostId, root })).toBe(getRepositoryKey(hostId, root));
    }
  }
});
test('local state keys are unchanged and remote state keys include host identity', () => {
  expect(getRepositoryStateKey({ root: '/srv/app' })).toBe('/srv/app');
  expect(getRepositoryStateKey({ hostId: 'local', root: '/srv/app' })).toBe('/srv/app');
  expect(getRepositoryStateKey({ hostId: 'ssh://first', root: '/srv/app' })).toBe(
    'ssh://first\0/srv/app',
  );
  expect(getRepositoryStateKey({ hostId: 'ssh://second', root: '/srv/app' })).not.toBe(
    getRepositoryStateKey({ hostId: 'ssh://first', root: '/srv/app' }),
  );
});
import { createRequire } from 'node:module';
