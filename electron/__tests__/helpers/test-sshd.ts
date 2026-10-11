import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type TestSshd = {
  alias: 'codiff-test';
  controlDirectory: string;
  getLog: () => string;
  port: number;
  root: string;
  sshConfigPath: string;
  stop: () => Promise<void>;
  unreachableAlias: 'codiff-unreachable';
  [Symbol.asyncDispose]: () => Promise<void>;
};

export const findSshd = () =>
  ['/usr/sbin/sshd', '/usr/bin/sshd', '/opt/homebrew/sbin/sshd'].find((path) => existsSync(path)) ??
  null;

const getFreePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

const canConnect = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

const waitForPort = async (port: number, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Test sshd did not start on port ${port}.`);
};

const generateKey = (path: string) =>
  execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'codiff-test', '-f', path]);

/**
 * Starts a non-root sshd on 127.0.0.1 that accepts one generated key for the
 * current user. The root lives under /tmp so `<root>/cm/%C` stays below the
 * 104-byte Unix socket path limit on macOS.
 */
export const startTestSshd = async ({
  authorize = true,
}: { authorize?: boolean } = {}): Promise<TestSshd> => {
  const sshd = findSshd();
  if (!sshd) {
    throw new Error('sshd is not installed. Install openssh-server to run SSH host tests.');
  }
  const root = await mkdtemp('/tmp/cdf-');
  await Promise.all([
    generateKey(join(root, 'host_key')),
    generateKey(join(root, 'client_key')),
    generateKey(join(root, 'other_key')),
  ]);
  const authorizedKey = await readFile(
    join(root, authorize ? 'client_key.pub' : 'other_key.pub'),
    'utf8',
  );
  await writeFile(join(root, 'authorized_keys'), authorizedKey, { mode: 0o600 });
  const [port, unreachablePort] = await Promise.all([getFreePort(), getFreePort()]);
  await writeFile(
    join(root, 'sshd_config'),
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${join(root, 'host_key')}`,
      `AuthorizedKeysFile ${join(root, 'authorized_keys')}`,
      `PidFile ${join(root, 'sshd.pid')}`,
      'UsePAM no',
      'StrictModes no',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'AcceptEnv GIT_* CODIFF_*',
      '',
    ].join('\n'),
  );
  const user = userInfo().username;
  const clientOptions = [
    `  User ${user}`,
    `  IdentityFile ${join(root, 'client_key')}`,
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking no',
    `  UserKnownHostsFile ${join(root, 'known_hosts')}`,
    '  SendEnv GIT_* CODIFF_*',
  ];
  const sshConfigPath = join(root, 'ssh_config');
  await writeFile(
    sshConfigPath,
    [
      'Host codiff-test',
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      ...clientOptions,
      'Host codiff-unreachable',
      '  HostName 127.0.0.1',
      `  Port ${unreachablePort}`,
      ...clientOptions,
      '',
    ].join('\n'),
  );

  const server = spawn(sshd, ['-D', '-e', '-f', join(root, 'sshd_config')], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  server.stderr.on('data', (chunk: Buffer) => {
    log += chunk.toString('utf8');
  });
  try {
    await waitForPort(port);
  } catch (error) {
    server.kill();
    throw new Error(`${(error as Error).message}\n${log}`);
  }

  const controlDirectory = join(root, 'cm');
  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    await execFileAsync('ssh', [
      '-F',
      sshConfigPath,
      '-o',
      `ControlPath=${join(controlDirectory, '%C')}`,
      '-O',
      'exit',
      'codiff-test',
    ]).catch(() => {});
    if (server.exitCode == null) {
      server.kill();
      await once(server, 'exit');
    }
    await rm(root, { force: true, recursive: true });
  };

  return {
    alias: 'codiff-test',
    controlDirectory,
    getLog: () => log,
    port,
    root,
    sshConfigPath,
    stop,
    unreachableAlias: 'codiff-unreachable',
    [Symbol.asyncDispose]: stop,
  };
};
