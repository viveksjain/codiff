import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vite-plus/test';
import type { RepositoryHost } from '../host/repository-host.cjs';
import { findSshd, startTestSshd } from './helpers/test-sshd.ts';

type SshResult = { code: number | null; stderr: string; stdout: Buffer };
type SshHost = RepositoryHost & {
  close: () => Promise<void>;
  getConnectionState: () => string;
  onConnectionState: (listener: (state: string) => void) => () => void;
  reconnect: () => Promise<void>;
};
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

const processClosed = (child: ReturnType<RepositoryHost['spawn']>) =>
  new Promise<Array<unknown>>((resolve) => child.on('close', (...args) => resolve(args)));

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

test('unsupported stat implementations are rejected during connect', async () => {
  await expect(
    connectSshHost({
      connection: createFakeConnection(['__codiff_shell__:/bin/bash\n', 'unsupported\n']),
    }),
  ).rejects.toThrow(/GNU or BSD stat/);
});

describe.skipIf(!findSshd())('SshHost connection failures', () => {
  test('closing rejects later work and kills an active remote process', async () => {
    await using sshd = await startTestSshd();
    const host = await connectSshHost({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    const child = host.spawn('/bin/sh', ['-c', 'echo $$; exec sleep 60']);
    const pid = await new Promise<string>((resolve) =>
      child.stdout.once('data', (data) => resolve(data.toString().trim())),
    );
    const closed = processClosed(child);
    await host.close();
    await closed;
    expect(host.getConnectionState()).toBe('closed');
    await expect(host.exec('true', [])).rejects.toThrow(/closed/i);
    expect(() => host.spawn('true', [])).toThrow(/closed/i);
    const probe = await connectSshHost({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    try {
      await expect(probe.exec('kill', ['-0', pid])).rejects.toThrow();
    } finally {
      await probe.close();
    }
  });

  test('spawns share bounded channels, including queued cancellation', async () => {
    await using sshd = await startTestSshd();
    const host = await connectSshHost({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    try {
      const children = Array.from({ length: 14 }, () =>
        host.spawn('/bin/sh', ['-c', 'sleep 0.1; printf ran']),
      );
      const results = children.map(async (child) => {
        let output = '';
        child.stdout.on('data', (data) => {
          output += data;
        });
        child.stderr.resume();
        const [code] = await processClosed(child);
        return { code, output };
      });
      expect(await Promise.all(results)).toEqual(
        Array.from({ length: 14 }, () => ({ code: 0, output: 'ran' })),
      );
      const blockers = Array.from({ length: 6 }, () => host.spawn('sleep', ['60']));
      const closed = blockers.map((child) => {
        child.stdout.resume();
        child.stderr.resume();
        return processClosed(child);
      });
      const queued = host.spawn('sleep', ['60']);
      const queuedClosed = processClosed(queued);
      queued.kill();
      expect(
        await Promise.race([
          queuedClosed.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
        ]),
      ).toBe(true);
      blockers.forEach((child) => child.kill());
      await Promise.all(closed);
    } finally {
      await host.close();
    }
  });

  test('connection state reports loss and reconnect and classifies spawn failures', async () => {
    await using sshd = await startTestSshd();
    const options = {
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    };
    const host = await connectSshHost(options);
    const states: Array<string> = [];
    const dispose = host.onConnectionState((state) => states.push(state));
    try {
      await host.exec('true', []);
      await createSshConnection(options).exitMaster();
      const child = host.spawn('true', []);
      child.stdout.resume();
      child.stderr.resume();
      const error = new Promise<Error>((resolve) => child.on('error', resolve));
      expect(await error).toMatchObject({ name: 'HostDisconnectedError' });
      await host.reconnect();
      expect(host.getConnectionState()).toBe('connected');
      expect(states).toContain('disconnected');
      expect(states.at(-1)).toBe('connected');
      expect((await host.exec('printf', ['back'])).toString()).toBe('back');
    } finally {
      dispose();
      await host.close();
    }
  });
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

  test('configured forwarding and LocalCommand are ignored by master and clients', async () => {
    await using sshd = await startTestSshd();
    const occupied = createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    const address = occupied.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP listener.');
    }
    const marker = join(sshd.root, 'local-command-ran');
    try {
      await appendFile(
        sshd.sshConfigPath,
        `Host codiff-test\n  LocalForward 127.0.0.1:${address.port} 127.0.0.1:${sshd.port}\n  ExitOnForwardFailure yes\n  PermitLocalCommand yes\n  LocalCommand touch ${marker}\n`,
      );
      const host = await connectSshHost({
        alias: sshd.alias,
        controlDirectory: sshd.controlDirectory,
        sshConfigPath: sshd.sshConfigPath,
      });
      try {
        expect((await host.exec('printf', ['ran'])).toString('utf8')).toBe('ran');
        expect(existsSync(marker)).toBe(false);
      } finally {
        await host.close();
      }
    } finally {
      const closed = once(occupied, 'close');
      occupied.close();
      await closed;
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
        detail: expect.stringMatching(/\S/),
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
