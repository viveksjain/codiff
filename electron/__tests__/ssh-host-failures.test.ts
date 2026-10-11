import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vite-plus/test';
import type { RepositoryHost } from '../host/repository-host.cjs';
import { findSshd, startTestSshd } from './helpers/test-sshd.ts';

type SshResult = { code: number | null; stderr: string; stdout: Buffer };
type SshHost = RepositoryHost & { close: () => Promise<void> };
type FakeConnection = {
  alias: string;
  check: () => Promise<boolean>;
  ensureMaster: () => Promise<void>;
  exitMaster: () => Promise<void>;
  run: (remoteCommand: string) => Promise<SshResult>;
  spawnClient: () => never;
  startMaster: () => Promise<void>;
};

const require = createRequire(import.meta.url);
const { connectSshHost } = require('../host/ssh-host.cjs') as {
  connectSshHost: (options: {
    alias?: string;
    connection?: FakeConnection;
    controlDirectory?: string;
    masterCheckIntervalMs?: number;
    sshConfigPath?: string;
  }) => Promise<SshHost>;
};
const { createSshConnection } = require('../host/ssh-connection.cjs') as {
  createSshConnection: (options: {
    alias: string;
    controlDirectory: string;
    sshConfigPath: string;
  }) => {
    check: () => Promise<boolean>;
    exitMaster: () => Promise<void>;
  };
};

const execFileAsync = promisify(execFile);

const countMasters = async (controlDirectory: string) => {
  try {
    const { stdout } = await execFileAsync('pgrep', [
      '-f',
      `${controlDirectory}.*ControlPersist=yes`,
    ]);
    return stdout.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};

// A master that was just told to exit can take a moment to go away.
const waitForMasterCount = async (controlDirectory: string, expected: number, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  let count = await countMasters(controlDirectory);
  while (count !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    count = await countMasters(controlDirectory);
  }
  return count;
};

const createFakeConnection = (outputs: ReadonlyArray<string>): FakeConnection => {
  const queue = [...outputs];
  return {
    alias: 'devbox',
    check: async () => true,
    ensureMaster: async () => {},
    exitMaster: async () => {},
    run: async () => ({ code: 0, stderr: '', stdout: Buffer.from(queue.shift() ?? '') }),
    spawnClient: () => {
      throw new Error('not used');
    },
    startMaster: async () => {},
  };
};

test('a csh login shell is rejected', async () => {
  await expect(
    connectSshHost({ connection: createFakeConnection(['__codiff_shell__:/bin/tcsh\n']) }),
  ).rejects.toMatchObject({
    message: 'Codiff needs a POSIX or fish login shell on devbox.',
    name: 'UnsupportedRemoteShellError',
  });
});

test('shell startup files that print output are rejected', async () => {
  await expect(
    connectSshHost({
      connection: createFakeConnection(['Welcome to devbox!\n__codiff_shell__:/bin/bash\n']),
    }),
  ).rejects.toMatchObject({ name: 'RemoteShellNoiseError' });
});

test('a missing git is reported by name', async () => {
  await expect(
    connectSshHost({
      connection: createFakeConnection(['__codiff_shell__:/usr/bin/fish\n', 'gnu\nmissing:git\n']),
    }),
  ).rejects.toMatchObject({
    message: "git isn't installed on devbox.",
    name: 'RemoteCommandMissingError',
  });
});

describe.skipIf(!findSshd())('SshHost connection failures', () => {
  test('an unauthorized key needs an interactive login', async () => {
    await using sshd = await startTestSshd({ authorize: false });
    await expect(
      connectSshHost({
        alias: sshd.alias,
        controlDirectory: sshd.controlDirectory,
        sshConfigPath: sshd.sshConfigPath,
      }),
    ).rejects.toMatchObject({ name: 'HostAuthRequiredError' });
  });

  test('an unreachable host reports ssh output', async () => {
    await using sshd = await startTestSshd();
    await expect(
      connectSshHost({
        alias: sshd.unreachableAlias,
        controlDirectory: sshd.controlDirectory,
        sshConfigPath: sshd.sshConfigPath,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Connection refused/),
      name: 'HostUnreachableError',
    });
  });

  test('a RemoteCommand in the ssh config is ignored', async () => {
    await using sshd = await startTestSshd();
    await appendFile(sshd.sshConfigPath, 'Host codiff-test\n  RemoteCommand echo hijacked\n');
    const host = await connectSshHost({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    try {
      const output = (await host.exec('printf', ['ran'])).toString('utf8');
      expect(output).toBe('ran');
      expect(output).not.toMatch(/hijacked/);
    } finally {
      await host.close();
    }
  });

  test('a command that exits 255 is a command failure, not a lost connection', async () => {
    await using sshd = await startTestSshd();
    const host = await connectSshHost({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    try {
      await expect(
        host.exec('/bin/sh', ['-c', 'echo hook failed >&2; exit 255']),
      ).rejects.toMatchObject({
        message: expect.stringMatching(
          /^Command failed: \/bin\/sh -c echo hook failed >&2; exit 255\nhook failed/,
        ),
        name: 'Error',
      });
    } finally {
      await host.close();
    }
  });

  test('an operation after a lost master fails at once and the master comes back', async () => {
    await using sshd = await startTestSshd();
    const options = {
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    };
    const host = await connectSshHost(options);
    try {
      // This first operation runs the periodic master check, so the failure
      // below is the only thing that restores the master.
      expect((await host.exec('printf', ['before'])).toString('utf8')).toBe('before');
      const connection = createSshConnection(options);
      await connection.exitMaster();
      expect(await connection.check()).toBe(false);

      const started = Date.now();
      await expect(host.exec('printf', ['lost'])).rejects.toMatchObject({
        message: 'Lost connection to codiff-test.',
        name: 'HostDisconnectedError',
      });
      expect(Date.now() - started).toBeLessThan(2000);

      const deadline = Date.now() + 10_000;
      while (!(await connection.check())) {
        if (Date.now() > deadline) {
          throw new Error('The master did not come back.');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect((await host.exec('printf', ['back'])).toString('utf8')).toBe('back');
    } finally {
      await host.close();
    }
    expect(await waitForMasterCount(sshd.controlDirectory, 0)).toBe(0);
  });

  test('a stopped server is a lost connection', async () => {
    const sshd = await startTestSshd();
    const host = await connectSshHost({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    try {
      await sshd.stop();
      await expect(host.exec('true', [])).rejects.toMatchObject({
        message: 'Lost connection to codiff-test.',
        name: 'HostDisconnectedError',
      });
    } finally {
      await host.close();
      await sshd.stop();
    }
  });
});
