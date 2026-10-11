import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type { HostStat, RepositoryHost } from '../host/repository-host.cjs';
import { defineRepositoryHostContract } from './helpers/repository-host-contract.ts';
import { findSshd, startTestSshd, type TestSshd } from './helpers/test-sshd.ts';

type SshHost = RepositoryHost & { close: () => Promise<void> };
type SshResult = { code: number | null; stderr: string; stdout: Buffer };
type SshConnection = {
  alias: string;
  check: () => Promise<boolean>;
  ensureMaster: () => Promise<void>;
  exitMaster: () => Promise<void>;
  run: (remoteCommand: string, options?: { input?: string | Buffer }) => Promise<SshResult>;
  spawnClient: (
    remoteCommand: string,
    options?: { tty?: boolean },
  ) => import('node:child_process').ChildProcessWithoutNullStreams;
  startMaster: () => Promise<void>;
};

const require = createRequire(import.meta.url);
const {
  chunkByScriptSize,
  connectSshHost,
  createPidMarkerFilter,
  parseReadFilesOutput,
  parseStatLine,
  parseStatLines,
} = require('../host/ssh-host.cjs') as {
  chunkByScriptSize: (paths: ReadonlyArray<string>) => Array<Array<string>>;
  connectSshHost: (options: {
    alias: string;
    connection?: SshConnection;
    controlDirectory?: string;
    masterCheckIntervalMs?: number;
    spawnProcess?: typeof import('node:child_process').spawn;
    sshConfigPath?: string;
  }) => Promise<SshHost>;
  createPidMarkerFilter: (onPid: (pid: number) => void) => import('node:stream').Transform;
  parseReadFilesOutput: (output: Buffer, paths: ReadonlyArray<string>) => Array<Buffer | Error>;
  parseStatLine: (line: string) => HostStat;
  parseStatLines: (output: Buffer, count: number) => Array<HostStat | null>;
};
const { createSshConnection } = require('../host/ssh-connection.cjs') as {
  createSshConnection: (options: {
    alias: string;
    controlDirectory?: string;
    sshConfigPath?: string;
  }) => SshConnection;
};

const createConnection = (sshd: TestSshd) =>
  createSshConnection({
    alias: sshd.alias,
    controlDirectory: sshd.controlDirectory,
    sshConfigPath: sshd.sshConfigPath,
  });

const listMasters = () => {
  try {
    return execFileSync('pgrep', ['-fl', 'ControlPersist=yes'], { encoding: 'utf8' });
  } catch {
    return '';
  }
};

const readPid = (pidFile: string) => {
  const text = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : '';
  return text ? Number(text) : null;
};

const connect = (sshd: TestSshd) =>
  connectSshHost({
    alias: sshd.alias,
    controlDirectory: sshd.controlDirectory,
    sshConfigPath: sshd.sshConfigPath,
  });

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (condition: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Condition not met in time.');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const readStream = async (stream: import('node:stream').Readable) => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

test('the PID marker filter removes and reports only a leading marker line', async () => {
  const pids: Array<number> = [];
  const filter = createPidMarkerFilter((pid) => pids.push(pid));
  const output = readStream(filter);
  filter.write('__codiff_pid__:4');
  filter.write('2\r\nreal stderr\n');
  filter.end('__codiff_pid__:7\n');
  expect(await output).toBe('real stderr\n__codiff_pid__:7\n');
  expect(pids).toEqual([42]);

  const plain = createPidMarkerFilter((pid) => pids.push(pid));
  const plainOutput = readStream(plain);
  plain.end('fatal: not a git repository\n');
  expect(await plainOutput).toBe('fatal: not a git repository\n');
  expect(pids).toEqual([42]);
});

test('the PID marker filter drops login shell noise before the marker', async () => {
  const pids: Array<number> = [];
  const noisy = createPidMarkerFilter((pid) => pids.push(pid));
  const noisyOutput = readStream(noisy);
  noisy.write('bash: warning: setlocale: LC_ALL: cannot change locale (en_US.UTF-8)\r\n');
  noisy.write('\nmore noise\n__codiff_pid__:9');
  noisy.end('9\nreal stderr\n');
  expect(await noisyOutput).toBe('real stderr\n');
  expect(pids).toEqual([99]);

  // The scan is bounded: a marker after 8 KiB of noise is not trusted.
  const noise = `${'x'.repeat(99)}\n`.repeat(90);
  const bounded = createPidMarkerFilter((pid) => pids.push(pid));
  const boundedOutput = readStream(bounded);
  bounded.end(`${noise}__codiff_pid__:7\nreal stderr\n`);
  expect(await boundedOutput).toBe(`${noise}__codiff_pid__:7\nreal stderr\n`);
  expect(pids).toEqual([99]);
});

describe('connecting with shell noise', () => {
  const connectWith = (stdout: string, masterRunning: boolean) => {
    const calls: Array<string> = [];
    const connection: SshConnection = {
      alias: 'fake',
      check: async () => {
        calls.push('check');
        return masterRunning;
      },
      ensureMaster: async () => {
        calls.push('ensureMaster');
      },
      exitMaster: async () => {
        calls.push('exitMaster');
      },
      run: async () => ({ code: 0, stderr: '', stdout: Buffer.from(stdout) }),
      spawnClient: () => {
        throw new Error('Unexpected client.');
      },
      startMaster: async () => {},
    };
    return { calls, connecting: connectSshHost({ alias: 'fake', connection }) };
  };

  test.each([
    'Welcome!\n__codiff_shell__:/bin/zsh\n',
    '\n__codiff_shell__:/bin/zsh\n',
    '__codiff_shell__:/bin/zsh\n\n',
    '__codiff_shell__:/bin/zsh',
  ])('rejects %j and stops the master it started', async (stdout) => {
    const { calls, connecting } = connectWith(stdout, false);
    await expect(connecting).rejects.toMatchObject({ name: 'RemoteShellNoiseError' });
    expect(calls).toEqual(['check', 'ensureMaster', 'exitMaster']);
  });

  test('leaves a master it adopted running', async () => {
    const { calls, connecting } = connectWith('noise\n__codiff_shell__:/bin/zsh\n', true);
    await expect(connecting).rejects.toMatchObject({ name: 'RemoteShellNoiseError' });
    expect(calls).toEqual(['check', 'ensureMaster']);
  });
});

describe.skipIf(!findSshd())('SshHost commands', () => {
  test('a failed connect stops the master it started', async () => {
    await using sshd = await startTestSshd();
    const connection = createConnection(sshd);
    expect(await connection.check()).toBe(false);
    let masterStarted = false;
    await expect(
      connectSshHost({
        alias: sshd.alias,
        connection: {
          ...connection,
          run: async () => {
            masterStarted = await connection.check();
            return {
              code: 0,
              stderr: '',
              stdout: Buffer.from('Welcome!\n__codiff_shell__:/bin/sh\n'),
            };
          },
        },
      }),
    ).rejects.toMatchObject({ name: 'RemoteShellNoiseError' });
    expect(masterStarted).toBe(true);
    expect(await connection.check()).toBe(false);
    expect(listMasters()).not.toContain(sshd.controlDirectory);
  });

  test('an exec aborted while queued for a channel rejects at once', async () => {
    await using sshd = await startTestSshd();
    const host = await connect(sshd);
    const running = Array.from({ length: 6 }, () => host.exec('/bin/sh', ['-c', 'sleep 2']));
    const controller = new AbortController();
    const started = Date.now();
    const queued = host.exec('/bin/sh', ['-c', 'true'], { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(1000);
    await Promise.all(running);
    await host.close();
  });

  test('killing a spawn before it announces its PID stops the remote process', async () => {
    await using sshd = await startTestSshd();
    const host = await connect(sshd);
    for (const delay of [0, 5, 10]) {
      const pidFile = join(sshd.root, `early-${delay}.pid`);
      const child = host.spawn('/bin/sh', ['-c', `echo $$ > '${pidFile}'; exec sleep 30`]);
      child.stdin.end();
      child.stdout.resume();
      child.stderr.resume();
      const closed = new Promise((resolve) => child.on('close', () => resolve('closed')));
      await new Promise((resolve) => setTimeout(resolve, delay));
      const started = Date.now();
      child.kill();
      const outcome = await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(() => resolve('timed out'), 6000)),
      ]);
      const pid = readPid(pidFile);
      if (outcome !== 'closed' && pid != null && isRunning(pid)) {
        // Do not leave the sleeper behind when the assertions below fail.
        process.kill(pid);
      }
      expect(outcome).toBe('closed');
      expect(Date.now() - started).toBeLessThan(6000);
      if (pid != null) {
        await waitUntil(() => !isRunning(pid));
      }
    }
    await host.close();
  }, 30_000);

  test('killing twice or after exit sends at most one remote kill', async () => {
    await using sshd = await startTestSshd();
    const connection = createConnection(sshd);
    const killCommands: Array<string> = [];
    const host = await connectSshHost({
      alias: sshd.alias,
      connection: {
        ...connection,
        spawnClient: (remoteCommand, options) => {
          if (remoteCommand.includes('kill -TERM')) {
            killCommands.push(remoteCommand);
          }
          return connection.spawnClient(remoteCommand, options);
        },
      },
    });

    const pidFile = join(sshd.root, 'twice.pid');
    const sleeper = host.spawn('/bin/sh', ['-c', `echo $$ > '${pidFile}'; exec sleep 30`]);
    sleeper.stdin.end();
    sleeper.stdout.resume();
    sleeper.stderr.resume();
    await waitUntil(() => readPid(pidFile) != null);
    const pid = readPid(pidFile)!;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closed = new Promise((resolve) => sleeper.on('close', resolve));
    sleeper.kill();
    sleeper.kill();
    await closed;
    await waitUntil(() => !isRunning(pid));
    expect(killCommands).toHaveLength(1);

    const pty = host.spawnPty('/bin/sh', ['-c', 'exec sleep 30'], {
      cols: 80,
      name: 'xterm',
      rows: 24,
    });
    pty.onData(() => {});
    const ptyExited = new Promise((resolve) => pty.onExit(resolve));
    await new Promise((resolve) => setTimeout(resolve, 300));
    pty.kill();
    pty.kill();
    await ptyExited;
    expect(killCommands).toHaveLength(2);

    const done = host.spawn('/bin/sh', ['-c', 'exit 0']);
    done.stdin.end();
    done.stdout.resume();
    done.stderr.resume();
    await new Promise((resolve) => done.on('close', resolve));
    done.kill();
    sleeper.kill();
    pty.kill();
    expect(killCommands).toHaveLength(2);
    await host.close();
  });

  test('identifies itself by its ssh destination', async () => {
    await using sshd = await startTestSshd();
    const host = await connect(sshd);
    expect(host.id).toBe('ssh://codiff-test');
    expect(host.label).toBe('codiff-test');
    await host.close();
  });

  test('exec runs a remote command with exact arguments, input, cwd and env', async () => {
    await using sshd = await startTestSshd();
    await using directory = await createTemporaryDirectory("codiff ssh 'cwd' ");
    const host = await connect(sshd);
    const output = await host.exec(
      '/bin/sh',
      ['-c', 'pwd -P; printf "%s|%s|" "$1" "$CODIFF_VALUE"; cat', 'sh', `it's $(id)`],
      { cwd: directory.path, env: { CODIFF_VALUE: 'a "b"' }, input: Buffer.from([0, 1, 255]) },
    );
    const text = output.subarray(0, output.length - 3).toString('utf8');
    expect(text.endsWith(`it's $(id)|a "b"|`)).toBe(true);
    expect(text.split('\n')[0].endsWith(directory.path.split('/').pop()!)).toBe(true);
    expect([...output.subarray(output.length - 3)]).toEqual([0, 1, 255]);
    await host.close();
  });

  test('exec failures match the local error shapes', async () => {
    await using sshd = await startTestSshd();
    const host = await connect(sshd);
    await expect(host.exec('git', ['-C', '/', 'no-such-command'])).rejects.toThrow(
      /^Command failed: git -C \/ no-such-command\n[\s\S]*no-such-command/,
    );
    await expect(
      host.exec('/bin/sh', ['-c', 'echo boom >&2; exit 3'], { input: '' }),
    ).rejects.toThrow(/^boom\n$/);
    await expect(host.exec('/bin/sh', ['-c', 'exit 4'], { input: '' })).rejects.toThrow(
      '/bin/sh exited with status 4',
    );
    await host.close();
  });

  test('exec enforces maxBuffer', async () => {
    await using sshd = await startTestSshd();
    const host = await connect(sshd);
    await expect(
      host.exec('/bin/sh', ['-c', 'head -c 5000 /dev/zero'], { maxBuffer: 1000 }),
    ).rejects.toThrow('/bin/sh output exceeded 1000 bytes.');
    await host.close();
  });

  test('aborting exec stops the remote process', async () => {
    await using sshd = await startTestSshd();
    const host = await connect(sshd);
    const pidFile = join(sshd.root, 'exec.pid');
    const controller = new AbortController();
    const running = host.exec('/bin/sh', ['-c', `echo $$ > '${pidFile}'; exec sleep 30`], {
      signal: controller.signal,
    });
    const { readFileSync, existsSync } = await import('node:fs');
    await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(isRunning(pid)).toBe(true);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await waitUntil(() => !isRunning(pid));
    await host.close();
  });

  test('spawn streams output, reports the exit code and kills the remote process', async () => {
    await using sshd = await startTestSshd();
    const host = await connect(sshd);
    const child = host.spawn('/bin/sh', ['-c', 'printf out; printf err >&2; exit 4']);
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise((resolve) => child.on('close', resolve)),
    ]);
    expect({ code, stderr, stdout }).toEqual({ code: 4, stderr: 'err', stdout: 'out' });

    const pidFile = join(sshd.root, 'spawn.pid');
    const sleeper = host.spawn('/bin/sh', ['-c', `echo $$ > '${pidFile}'; exec sleep 30`]);
    sleeper.stdin.end();
    sleeper.stdout.resume();
    sleeper.stderr.resume();
    const { readFileSync, existsSync } = await import('node:fs');
    await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    sleeper.kill();
    await waitUntil(() => !isRunning(pid));
    await host.close();
  });

  test('spawnPty runs in a terminal and streams its output', async () => {
    await using sshd = await startTestSshd();
    const host = await connect(sshd);
    const pty = host.spawnPty(
      '/bin/sh',
      ['-c', 'test -t 1 && echo tty; echo "$TERM"; stty size; exit 3'],
      { cols: 80, name: 'xterm-256color', rows: 24 },
    );
    let output = '';
    pty.onData((data) => {
      output += data;
    });
    const exitCode = await new Promise<number>((resolve) =>
      pty.onExit(({ exitCode }) => resolve(exitCode)),
    );
    expect(exitCode).toBe(3);
    expect(output.replaceAll('\r\n', '\n')).toBe('tty\nxterm-256color\n24 80\n');
    await host.close();
  });
});

test('parses GNU and BSD stat output into host stats', () => {
  expect(parseStatLine('81a4 401 72290885 1769911025.860883671 1777163364.430570372')).toEqual({
    ctimeMs: 1777163364.430570372 * 1000,
    ino: 72290885,
    mode: 0o100644,
    mtimeMs: 1769911025.860883671 * 1000,
    size: 401,
    type: 'file',
  });
  expect(parseStatLine('41ed 64 2 1.5 1.5').type).toBe('directory');
  expect(parseStatLine('a1ff 8 3 1.5 1.5').type).toBe('symlink');
  expect(parseStatLine('11a4 0 4 1.5 1.5').type).toBe('other');
});

test('parses batched stat output and rejects misaligned output', () => {
  const stats = parseStatLines(Buffer.from('OK 81a4 1 2 1.5 1.5\nERR\nOK 41ed 64 3 2.5 2.5\n'), 3);
  expect(stats.map((stat) => stat?.type ?? null)).toEqual(['file', null, 'directory']);
  expect(() => parseStatLines(Buffer.from('OK 81a4 1 2 1.5 1.5\n'), 2)).toThrow(
    'Unexpected stat output.',
  );
});

test('parses length-framed batch reads, including newlines in contents', () => {
  const output = Buffer.concat([
    Buffer.from('OK 3\na\nb'),
    Buffer.from('ERR\n'),
    Buffer.from('OK 0\n'),
    Buffer.from('OK 2\n'),
    Buffer.from([0, 255]),
  ]);
  const results = parseReadFilesOutput(output, ['/a', '/missing', '/empty', '/binary']);
  expect(results[0]).toEqual(Buffer.from('a\nb'));
  expect(results[1]).toBeInstanceOf(Error);
  expect(results[2]).toEqual(Buffer.alloc(0));
  expect(results[3]).toEqual(Buffer.from([0, 255]));
  expect(() => parseReadFilesOutput(Buffer.from('OK 9\nabc'), ['/a'])).toThrow(
    'Unexpected batch read output.',
  );
});

test('splits large path batches below the remote argument limit', () => {
  const paths = Array.from(
    { length: 3000 },
    (_, index) => `/repo/${'d'.repeat(40)}/file-${index}.txt`,
  );
  const chunks = chunkByScriptSize(paths);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.flat()).toEqual(paths);
  for (const chunk of chunks) {
    expect(
      chunk.map((path) => path.length + 3).reduce((sum, size) => sum + size, 0),
    ).toBeLessThanOrEqual(64 * 1024);
  }
});

describe.skipIf(!findSshd())('SshHost contract', () => {
  let sshd: TestSshd;
  let host: SshHost;

  beforeAll(async () => {
    sshd = await startTestSshd();
    host = await connect(sshd);
  });

  afterAll(async () => {
    await host?.close();
    await sshd?.stop();
  });

  defineRepositoryHostContract('SshHost', async () => {
    const root = await host.mkdtemp('codiff-ssh-contract-');
    return {
      host,
      root,
      [Symbol.asyncDispose]: () => host.rm(root, { force: true, recursive: true }),
    };
  });
});

describe.skipIf(!findSshd())('SshHost batching', () => {
  test('batched calls use one remote command per chunk and none for empty input', async () => {
    await using sshd = await startTestSshd();
    const spawned: Array<string> = [];
    const { spawn } = await import('node:child_process');
    const host = await connectSshHost({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      // Only client sessions run remote commands; master checks and starts don't count.
      spawnProcess: ((command: string, args: ReadonlyArray<string>, options: object) => {
        if (args.includes('ControlMaster=auto')) {
          spawned.push(args.at(-1) ?? '');
        }
        return spawn(command, [...args], options);
      }) as unknown as typeof spawn,
      sshConfigPath: sshd.sshConfigPath,
    });
    const root = await host.mkdtemp('codiff-ssh-batch-');
    const paths = await Promise.all(
      Array.from({ length: 50 }, async (_, index) => {
        const path = join(root, `file-${index}.txt`);
        await host.writeFile(path, `value ${index}`);
        return path;
      }),
    );
    spawned.length = 0;
    expect(await host.lstatMany([])).toEqual([]);
    expect(await host.readFiles([])).toEqual([]);
    expect(spawned).toEqual([]);
    const stats = await host.lstatMany(paths);
    const contents = await host.readFiles(paths);
    expect(stats.every((stat) => stat?.type === 'file')).toBe(true);
    expect(contents.map((value) => value.toString())).toEqual(
      paths.map((_, index) => `value ${index}`),
    );
    expect(spawned).toHaveLength(2);
    await host.rm(root, { force: true, recursive: true });
    await host.close();
  });
});
