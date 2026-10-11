import { createRequire } from 'node:module';
import { afterAll } from 'vite-plus/test';
import { startTestSshd } from '../../../electron/__tests__/helpers/test-sshd.ts';
import type { RepositoryHost } from '../../../electron/host/repository-host.cjs';

/**
 * The repository host the git-state suites run against. Local by default; with
 * `CODIFF_TEST_HOST=ssh` every suite that imports this runs over a real ssh
 * connection to a throwaway sshd on 127.0.0.1, so the same assertions prove
 * that SshHost behaves like LocalHost. The test process's GIT_* variables are
 * forwarded (SendEnv/AcceptEnv), so Git identity and hook isolation still apply.
 *
 *   CODIFF_TEST_HOST=ssh vp test core/__tests__/git-state.test.ts ...
 */
const require = createRequire(import.meta.url);
const { createLocalHost } = require('../../../electron/host/local-host.cjs') as {
  createLocalHost: () => RepositoryHost;
};
const { connectSshHost } = require('../../../electron/host/ssh-host.cjs') as {
  connectSshHost: (options: {
    alias: string;
    controlDirectory: string;
    sshConfigPath: string;
  }) => Promise<RepositoryHost & { close: () => Promise<void> }>;
};

export const testHostKind: 'local' | 'ssh' =
  process.env.CODIFF_TEST_HOST === 'ssh' ? 'ssh' : 'local';

const createTestHost = async (): Promise<RepositoryHost> => {
  if (testHostKind === 'local') {
    return createLocalHost();
  }
  const sshd = await startTestSshd();
  const sshHost = await connectSshHost({
    alias: sshd.alias,
    controlDirectory: sshd.controlDirectory,
    sshConfigPath: sshd.sshConfigPath,
  }).catch(async (error: unknown) => {
    await sshd.stop();
    throw error;
  });
  afterAll(async () => {
    await sshHost.close();
    await sshd.stop();
  });
  return sshHost;
};

export const host = await createTestHost();
