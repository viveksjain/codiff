import { execFile, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vite-plus/test';
import { findSshd, startTestSshd } from './helpers/test-sshd.ts';

type SshResult = { code: number | null; stderr: string; stdout: Buffer };
type SpawnProcess = typeof spawn;
type SshConnection = {
  alias: string;
  check: () => Promise<boolean>;
  ensureMaster: () => Promise<void>;
  exitMaster: () => Promise<void>;
  run: (remoteCommand: string, options?: { input?: string | Buffer }) => Promise<SshResult>;
  startMaster: () => Promise<void>;
};

const require = createRequire(import.meta.url);
const { createSshConnection, isSocketStale } = require('../host/ssh-connection.cjs') as {
  createSshConnection: (options: {
    alias: string;
    controlDirectory?: string;
    masterStartTimeoutMs?: number;
    spawnProcess?: SpawnProcess;
    sshCommand?: string;
    sshConfigPath?: string;
  }) => SshConnection;
  isSocketStale: (path: string, timeoutMs?: number) => Promise<boolean>;
};

const execFileAsync = promisify(execFile);

const countingSpawn = () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const spawnProcess = ((command: string, args: ReadonlyArray<string>, options: object) => {
    calls.push(args);
    return spawn(command, args, options);
  }) as SpawnProcess;
  return {
    masterStarts: () => calls.filter((args) => args.includes('ControlMaster=yes')).length,
    spawnProcess,
  };
};

const pgrepMasters = async (controlDirectory: string) => {
  try {
    const { stdout } = await execFileAsync('pgrep', [
      '-f',
      `${controlDirectory}.*ControlPersist=yes`,
    ]);
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

// A master that was just told to exit or killed can take a moment to go away.
const waitForMasters = async (
  controlDirectory: string,
  matches: (masters: Array<string>) => boolean,
  timeoutMs = 3000,
) => {
  const deadline = Date.now() + timeoutMs;
  let masters = await pgrepMasters(controlDirectory);
  while (!matches(masters) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    masters = await pgrepMasters(controlDirectory);
  }
  return masters;
};

test('rejects destinations that ssh would parse as options', () => {
  expect(() =>
    createSshConnection({ alias: '-oProxyCommand=evil', controlDirectory: '/tmp' }),
  ).toThrow('Invalid SSH host: -oProxyCommand=evil');
  expect(() => createSshConnection({ alias: 'host:path', controlDirectory: '/tmp' })).toThrow();
  expect(() => createSshConnection({ alias: 'a@-b', controlDirectory: '/tmp' })).toThrow(
    'Invalid SSH host: a@-b',
  );
});

test('a missing ssh binary is reported with its own error', async () => {
  const connection = createSshConnection({
    alias: 'somewhere',
    controlDirectory: '/tmp',
    sshCommand: '/nonexistent/ssh',
  });
  await expect(connection.startMaster()).rejects.toMatchObject({
    message: expect.stringMatching(/ENOENT/),
    name: 'HostUnreachableError',
  });
});

test('a master start that never finishes times out and is killed', async () => {
  let killed = false;
  const spawnProcess = ((command: string, args: ReadonlyArray<string>, options: object) => {
    if (args.includes('ControlMaster=yes')) {
      const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
      child.kill = () => {
        killed = true;
        return true;
      };
      return child;
    }
    return spawn(command, args, options);
  }) as unknown as SpawnProcess;
  const connection = createSshConnection({
    alias: 'somewhere',
    controlDirectory: '/tmp',
    masterStartTimeoutMs: 20,
    spawnProcess,
    sshCommand: '/nonexistent/ssh',
  });
  await expect(connection.startMaster()).rejects.toMatchObject({
    message: 'Timed out connecting to somewhere.',
    name: 'HostUnreachableError',
  });
  expect(killed).toBe(true);
});

test('only a socket that nothing listens on is stale', async () => {
  const directory = await mkdtemp('/tmp/cdf-sock-');
  try {
    const path = join(directory, 'socket');
    expect(await isSocketStale(path)).toBe(true);

    const server = createServer((socket) => socket.destroy());
    server.listen(path);
    await once(server, 'listening');
    try {
      expect(await isSocketStale(path)).toBe(false);
      // Any error other than "refused" or "missing" is not proof of staleness.
      await chmod(directory, 0o000);
      try {
        expect(await isSocketStale(path)).toBe(false);
      } finally {
        await chmod(directory, 0o700);
      }
    } finally {
      server.close();
      await once(server, 'close');
    }

    // A process that exits without closing its server leaves the socket behind.
    await execFileAsync(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`,
    ]);
    expect(existsSync(path)).toBe(true);
    expect(await isSocketStale(path)).toBe(true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

describe.skipIf(!findSshd())('ssh connection', () => {
  test('starts, checks, uses and exits a master connection', async () => {
    await using sshd = await startTestSshd();
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    expect(await connection.check()).toBe(false);
    await connection.startMaster();
    expect(await connection.check()).toBe(true);

    const result = await connection.run('cat; echo " $$"', { input: 'hello' });
    expect(result.code).toBe(0);
    expect(result.stdout.toString('utf8')).toMatch(/^hello \d+\n$/);

    const exitCode = await connection.run('exit 7');
    expect(exitCode.code).toBe(7);

    await connection.exitMaster();
    expect(await connection.check()).toBe(false);
  });

  test('a control directory with a space works', async () => {
    await using sshd = await startTestSshd();
    // Under /tmp so the socket path stays below the Unix socket length limit.
    const controlDirectory = await mkdtemp('/tmp/cdf-sp ');
    try {
      const connection = createSshConnection({
        alias: sshd.alias,
        controlDirectory,
        sshConfigPath: sshd.sshConfigPath,
      });
      await connection.startMaster();
      expect(await connection.check()).toBe(true);
      const result = await connection.run('echo works');
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(result.stdout.toString('utf8')).toBe('works\n');
      await connection.exitMaster();
      expect(await connection.check()).toBe(false);
      expect(
        await waitForMasters(controlDirectory, (masters) => masters.length === 0),
      ).toHaveLength(0);
    } finally {
      await rm(controlDirectory, { force: true, recursive: true });
    }
  });

  test('client commands are multiplexed over the master', async () => {
    await using sshd = await startTestSshd();
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    await connection.startMaster();
    const first = await connection.run('echo "$SSH_CONNECTION"');
    const second = await connection.run('echo "$SSH_CONNECTION"');
    expect(first.code).toBe(0);
    expect(first.stdout.toString('utf8')).toMatch(/\S/);
    expect(second.stdout.toString('utf8')).toBe(first.stdout.toString('utf8'));
    await connection.exitMaster();
  });

  test('a remote command is never parsed as an ssh option', async () => {
    await using sshd = await startTestSshd();
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    await connection.startMaster();
    const result = await connection.run('-V');
    expect(result.code).not.toBe(0);
    expect(result.stdout.toString('utf8')).not.toMatch(/OpenSSH/);
    expect(result.stderr).not.toMatch(/OpenSSH/);
    await connection.exitMaster();
  });

  test('recovers from a stale control socket without leaking masters', async () => {
    await using sshd = await startTestSshd();
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    await connection.startMaster();
    const checkArgs = [
      '-F',
      sshd.sshConfigPath,
      '-o',
      `ControlPath=${sshd.controlDirectory}/%C`,
      '-O',
      'check',
      '--',
      sshd.alias,
    ];
    const { stderr } = await execFileAsync('ssh', checkArgs);
    const pid = Number(/pid=(\d+)/.exec(stderr)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(
      await waitForMasters(sshd.controlDirectory, (masters) => masters.length === 1),
    ).toHaveLength(1);

    process.kill(pid, 'SIGKILL');
    for (let attempt = 0; attempt < 100 && (await connection.check()); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await connection.check()).toBe(false);

    await connection.ensureMaster();
    expect(await connection.check()).toBe(true);
    const after = await execFileAsync('ssh', checkArgs);
    const newPid = Number(/pid=(\d+)/.exec(after.stderr)?.[1]);
    expect(newPid).not.toBe(pid);
    const masters = await waitForMasters(
      sshd.controlDirectory,
      (current) => current.length === 1 && current[0] === String(newPid),
    );
    expect(masters).toEqual([String(newPid)]);

    await connection.exitMaster();
    expect(await connection.check()).toBe(false);
    expect(
      await waitForMasters(sshd.controlDirectory, (current) => current.length === 0),
    ).toHaveLength(0);
  });

  test('without a master, a client fails at once and never connects on its own', async () => {
    await using sshd = await startTestSshd();
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    expect(await connection.check()).toBe(false);
    // sshd logs every accepted login and every dropped pre-auth connection, so
    // an unchanged log means the client never reached the server.
    const logBefore = sshd.getLog();
    const started = Date.now();
    const result = await connection.run('echo connected');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.code).toBe(255);
    expect(result.stdout.toString('utf8')).toBe('');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sshd.getLog().match(/Accepted publickey/g) ?? []).toEqual(
      logBefore.match(/Accepted publickey/g) ?? [],
    );
    expect(sshd.getLog()).toBe(logBefore);
    expect(await connection.check()).toBe(false);
  });

  test('ensureMaster starts a master once for concurrent callers', async () => {
    await using sshd = await startTestSshd();
    const counter = countingSpawn();
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      spawnProcess: counter.spawnProcess,
      sshConfigPath: sshd.sshConfigPath,
    });
    await Promise.all([
      connection.ensureMaster(),
      connection.ensureMaster(),
      connection.ensureMaster(),
    ]);
    expect(await connection.check()).toBe(true);
    expect(counter.masterStarts()).toBe(1);
    await connection.exitMaster();
  });

  test('failed ensureMaster calls share one attempt and later calls retry', async () => {
    await using sshd = await startTestSshd({ authorize: false });
    const counter = countingSpawn();
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      spawnProcess: counter.spawnProcess,
      sshConfigPath: sshd.sshConfigPath,
    });
    const results = await Promise.allSettled([
      connection.ensureMaster(),
      connection.ensureMaster(),
      connection.ensureMaster(),
    ]);
    for (const result of results) {
      expect(result).toMatchObject({
        reason: { name: 'HostAuthRequiredError' },
        status: 'rejected',
      });
    }
    expect(counter.masterStarts()).toBe(1);
    await expect(connection.ensureMaster()).rejects.toMatchObject({
      name: 'HostAuthRequiredError',
    });
    expect(counter.masterStarts()).toBe(2);
  });

  test('a failed master start reports an authentication problem', async () => {
    await using sshd = await startTestSshd({ authorize: false });
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    await expect(connection.startMaster()).rejects.toMatchObject({ name: 'HostAuthRequiredError' });
  });

  test('a failed master start reports an unreachable host', async () => {
    await using sshd = await startTestSshd();
    const connection = createSshConnection({
      alias: sshd.unreachableAlias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    await expect(connection.startMaster()).rejects.toMatchObject({
      message: expect.stringMatching(/Connection refused/),
      name: 'HostUnreachableError',
    });
  });
});
