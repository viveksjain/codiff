import { execFile, execFileSync, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
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
  spawnClient: (remoteCommand: string) => ReturnType<typeof spawn>;
  startMaster: () => Promise<void>;
};

const require = createRequire(import.meta.url);
const { createSshConnection, isSocketStale } = require('../host/ssh-connection.cjs') as {
  createSshConnection: (options: {
    alias: string;
    controlDirectory?: string;
    masterStartTimeoutMs?: number;
    port?: number;
    interactive?: boolean;
    getLocalEnvironment?: () => Promise<NodeJS.ProcessEnv>;
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
      `${controlDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*ControlPersist=yes`,
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
      const child = new EventEmitter() as EventEmitter & {
        kill: () => boolean;
        stderr: PassThrough;
      };
      child.stderr = new PassThrough();
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
  test('scoped sockets fit in a longer control directory', async () => {
    await using sshd = await startTestSshd();
    const controlDirectory = await mkdtemp(`/tmp/${'x'.repeat(27)}`);
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    try {
      await connection.ensureMaster();
      const result = await connection.run('printf connected');
      expect(result.code).toBe(0);
      expect(result.stdout.toString()).toBe('connected');
    } finally {
      await connection.exitMaster();
      await rm(controlDirectory, { force: true, recursive: true });
    }
  });

  test('closing one alias keeps another alias for the same endpoint usable', async () => {
    await using sshd = await startTestSshd();
    const config = await readFile(sshd.sshConfigPath, 'utf8');
    await writeFile(
      sshd.sshConfigPath,
      config.replace('Host codiff-test\n', 'Host codiff-test codiff-second\n'),
    );
    const first = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    const second = createSshConnection({
      alias: 'codiff-second',
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    try {
      await first.ensureMaster();
      await second.ensureMaster();
      expect((await second.run('printf before')).stdout.toString()).toBe('before');
      await first.exitMaster();
      const result = await second.run('printf after');
      expect(result.code).toBe(0);
      expect(result.stdout.toString()).toBe('after');
    } finally {
      await first.exitMaster();
      await second.exitMaster();
    }
  });

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

  test.each(['space ', 'quote"', 'backslash\\', 'percent%test'])(
    'a control directory with %s works',
    async (suffix) => {
      await using sshd = await startTestSshd();
      // Under /tmp so the socket path stays below the Unix socket length limit.
      const controlDirectory = await mkdtemp(`/tmp/cdf-${suffix}`);
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
    },
  );

  test('a start that loses the socket adopts the winner without leaking a connection', async () => {
    await using sshd = await startTestSshd();
    // Start a competing, real master just after this connection's preflight
    // check, so it wins the socket before this start binds it.
    const spawnProcess = ((command: string, args: ReadonlyArray<string>, options: object) => {
      if (args.includes('ControlMaster=yes')) {
        execFileSync(command, args, { ...options, stdio: 'pipe' });
      }
      return spawn(command, args, options);
    }) as SpawnProcess;
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      masterStartTimeoutMs: 1000,
      spawnProcess,
      sshConfigPath: sshd.sshConfigPath,
    });
    try {
      await connection.startMaster();
      expect(await connection.check()).toBe(true);
      expect((await connection.run('printf winner')).stdout.toString('utf8')).toBe('winner');
      expect(
        await waitForMasters(sshd.controlDirectory, (masters) => masters.length === 1),
      ).toHaveLength(1);
      await connection.exitMaster();
      expect(
        await waitForMasters(sshd.controlDirectory, (masters) => masters.length === 0),
      ).toHaveLength(0);
    } finally {
      await connection.exitMaster();
      // Reap the losing connection too when running against the broken code.
      for (const pid of await pgrepMasters(sshd.controlDirectory)) {
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch {}
      }
    }
  });

  test('a failed ProxyJump preserves ssh transport diagnostics', async () => {
    await using sshd = await startTestSshd();
    await appendFile(sshd.sshConfigPath, 'Host codiff-test\n  ProxyJump codiff-unreachable\n');
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    await expect(connection.startMaster()).rejects.toMatchObject({
      message: expect.stringContaining('Connection closed'),
      name: 'HostUnreachableError',
    });
  });

  test('a master through ProxyJump detaches and serves multiplexed clients', async () => {
    await using sshd = await startTestSshd();
    const config = await readFile(sshd.sshConfigPath, 'utf8');
    await writeFile(
      sshd.sshConfigPath,
      `${config.replace('Host codiff-test\n', 'Host codiff-test codiff-jump\n')}\nHost codiff-test\n  ProxyJump codiff-jump\n`,
    );
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    try {
      await connection.startMaster();
      const first = await connection.run('echo "$SSH_CONNECTION"');
      const second = await connection.run('echo "$SSH_CONNECTION"');
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(first.stdout.toString('utf8')).toMatch(/\S/);
      expect(second.stdout).toEqual(first.stdout);
      const client = connection.spawnClient('printf spawned');
      let output = '';
      client.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      const [code] = await once(client, 'close');
      expect(code).toBe(0);
      expect(output).toBe('spawned');
    } finally {
      await connection.exitMaster();
    }
    expect(
      await waitForMasters(sshd.controlDirectory, (masters) => masters.length === 0),
    ).toHaveLength(0);
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
    const [socket] = await readdir(sshd.controlDirectory);
    const checkArgs = [
      '-F',
      sshd.sshConfigPath,
      '-S',
      join(sshd.controlDirectory, socket),
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

test('resolves the local environment asynchronously before invoking ssh', async () => {
  const environments: Array<NodeJS.ProcessEnv> = [];
  const spawnProcess = ((
    command: string,
    args: ReadonlyArray<string>,
    options: { env: NodeJS.ProcessEnv },
  ) => {
    environments.push(options.env);
    return spawn(command, args, options);
  }) as SpawnProcess;
  const connection = createSshConnection({
    alias: 'localhost',
    controlDirectory: '/tmp',
    sshCommand: '/nonexistent/ssh',
    spawnProcess,
    getLocalEnvironment: async () => ({ SSH_AUTH_SOCK: '/agent/socket', PATH: process.env.PATH }),
  });
  await connection.check();
  expect(environments.every((env) => env.SSH_AUTH_SOCK === '/agent/socket')).toBe(true);
});

test('validates explicit SSH ports', () => {
  for (const port of [0, -1, 65536, 1.5]) {
    expect(() =>
      createSshConnection({ alias: 'localhost', port, controlDirectory: '/tmp' }),
    ).toThrow(/port/i);
  }
});

describe.skipIf(!findSshd())('explicit connection settings', () => {
  test('terminal masters and explicit ports reuse the same socket', async () => {
    await using sshd = await startTestSshd();
    const connection = createSshConnection({
      alias: sshd.alias,
      port: sshd.port,
      interactive: true,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    try {
      await connection.ensureMaster();
      expect((await connection.run('printf ran')).stdout.toString()).toBe('ran');
    } finally {
      await connection.exitMaster();
    }
  });
});
