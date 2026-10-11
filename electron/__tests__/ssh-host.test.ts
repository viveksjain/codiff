import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type { RepositoryHost } from '../host/repository-host.cjs';
import { findSshd, startTestSshd, type TestSshd } from './helpers/test-sshd.ts';

type SshHost = RepositoryHost & { close: () => Promise<void> };

const require = createRequire(import.meta.url);
const { connectSshHost, createPidMarkerFilter } = require('../host/ssh-host.cjs') as {
  connectSshHost: (options: {
    alias: string;
    controlDirectory?: string;
    masterCheckIntervalMs?: number;
    sshConfigPath?: string;
  }) => Promise<SshHost>;
  createPidMarkerFilter: (onPid: (pid: number) => void) => import('node:stream').Transform;
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

describe.skipIf(!findSshd())('SshHost commands', () => {
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
