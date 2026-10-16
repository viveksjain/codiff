import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
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

type ServerState = { failure: Error | null; log: string };

// Resolves once this sshd reports that it is listening. A TCP readiness probe
// would leave delayed pre-auth log entries that tests could mistake for clients.
// Rejects as soon as sshd exits or fails to spawn, so a port that is already
// bound by someone else cannot be mistaken for a working server.
const waitForServer = async (port: number, state: ServerState, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.failure) {
      throw state.failure;
    }
    if (state.log.includes('Server listening')) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Test sshd did not start on port ${port}.`);
};

const hasExited = (child: ChildProcess) => child.exitCode != null || child.signalCode != null;

const terminate = async (child: ChildProcess) => {
  // No pid means the spawn itself failed, so there is no process and no 'exit'.
  if (child.pid == null || hasExited(child)) {
    return;
  }
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (!hasExited(child)) {
      child.kill('SIGKILL');
    }
  }, 2000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
};

const generateKey = (path: string) =>
  execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'codiff-test', '-f', path]);

/**
 * Starts a non-root sshd on 127.0.0.1 that accepts one generated key for the
 * current user. The root lives under /tmp so the scoped control sockets stay below the
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
  const state: ServerState = { failure: null, log: '' };
  let server: ChildProcess | undefined;
  let port: number;
  let sshConfigPath: string;
  try {
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
    let unreachablePort: number;
    [port, unreachablePort] = await Promise.all([getFreePort(), getFreePort()]);
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
    sshConfigPath = join(root, 'ssh_config');
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

    server = spawn(sshd, ['-D', '-e', '-f', join(root, 'sshd_config')], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    server.stderr?.on('data', (chunk: Buffer) => {
      state.log += chunk.toString('utf8');
    });
    server.once('error', (error) => {
      state.failure ??= error;
    });
    server.once('exit', (code, signal) => {
      state.failure ??= new Error(`Test sshd exited (${signal ?? code}) before it was ready.`);
    });
    await waitForServer(port, state);
  } catch (error) {
    if (server) {
      await terminate(server).catch(() => {});
    }
    await rm(root, { force: true, recursive: true });
    const message = (error as Error).message;
    throw new Error(state.log ? `${message}\n${state.log}` : message, { cause: error });
  }

  const controlDirectory = join(root, 'cm');
  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    const sockets = await readdir(controlDirectory, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      sockets
        .filter((entry) => entry.isSocket())
        .map((entry) =>
          execFileAsync('ssh', [
            '-F',
            sshConfigPath,
            '-S',
            join(controlDirectory, entry.name).replaceAll('%', '%%'),
            '-O',
            'exit',
            'codiff-test',
          ]).catch(() => {}),
        ),
    );
    await terminate(server);
    await rm(root, { force: true, recursive: true });
  };

  return {
    alias: 'codiff-test',
    controlDirectory,
    getLog: () => state.log,
    port,
    root,
    sshConfigPath,
    stop,
    unreachableAlias: 'codiff-unreachable',
    [Symbol.asyncDispose]: stop,
  };
};
