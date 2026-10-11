import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import type { RepositoryHost } from '../host/repository-host.cjs';
const require = createRequire(import.meta.url);
const { createHostRegistry } = require('../host/host-registry.cjs');
const { parseRepositoryTarget } = require('../host/repository-target.cjs');
const localHost = { id: 'local', label: '' } as RepositoryHost;

test('concurrent leases share one host and last release closes it', async () => {
  let starts = 0;
  let stops = 0;
  const host = {
    ...localHost,
    id: 'ssh://devbox',
    close: async () => {
      stops++;
    },
  };
  const registry = createHostRegistry({
    localHost,
    connect: async () => {
      starts++;
      await Promise.resolve();
      return host;
    },
  });
  const target = parseRepositoryTarget('devbox:/app');
  const [first, second] = await Promise.all([registry.acquire(target), registry.acquire(target)]);
  expect(starts).toBe(1);
  expect(first.host).toBe(second.host);
  await first.release();
  expect(stops).toBe(0);
  await second.release();
  expect(stops).toBe(1);
  await second.release();
  await registry.close();
  expect(stops).toBe(1);
});
test('ports distinguish hosts and failed connects can retry', async () => {
  let starts = 0;
  const registry = createHostRegistry({
    localHost,
    connect: async ({ port }: { port: number }) => {
      starts++;
      if (starts === 1) {
        throw new Error('failed');
      }
      return { ...localHost, id: `ssh://devbox:${port}`, close: async () => {} };
    },
  });
  await expect(registry.acquire(parseRepositoryTarget('ssh://devbox:2222/app'))).rejects.toThrow(
    'failed',
  );
  const first = await registry.acquire(parseRepositoryTarget('ssh://devbox:2222/app'));
  const second = await registry.acquire(parseRepositoryTarget('ssh://devbox:2223/app'));
  expect(first.host.id).not.toBe(second.host.id);
  expect(starts).toBe(3);
  await registry.close();
});
test('quit during connect drains the new host and rejects its pending lease', async () => {
  let resolveConnect: (host: unknown) => void = () => {};
  let stops = 0;
  const registry = createHostRegistry({
    localHost,
    connect: () =>
      new Promise((resolve) => {
        resolveConnect = resolve;
      }),
  });
  const acquired = registry.acquire(parseRepositoryTarget('devbox:/app'));
  const rejected = expect(acquired).rejects.toThrow(/closed/i);
  await Promise.resolve();
  const closed = registry.close();
  resolveConnect({
    ...localHost,
    close: async () => {
      stops++;
    },
  });
  await closed;
  await rejected;
  expect(stops).toBe(1);
  await expect(registry.acquire(parseRepositoryTarget('devbox:/app'))).rejects.toThrow(/closed/i);
});
test('passes asynchronously resolved login environment to the connection', async () => {
  let environment;
  const registry = createHostRegistry({
    localHost,
    getLocalEnvironment: async () => ({ SSH_AUTH_SOCK: '/agent/ssh' }),
    connect: async ({
      getLocalEnvironment,
    }: {
      getLocalEnvironment: () => Promise<NodeJS.ProcessEnv>;
    }) => {
      environment = await getLocalEnvironment();
      return { ...localHost, close: async () => {} };
    },
  });
  await registry.acquire(parseRepositoryTarget('devbox:/app'));
  expect(environment).toMatchObject({ SSH_AUTH_SOCK: '/agent/ssh' });
  await registry.close();
});
