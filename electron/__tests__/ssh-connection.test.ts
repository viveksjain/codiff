import { createRequire } from 'node:module';
import { describe, expect, test } from 'vite-plus/test';
import { findSshd, startTestSshd } from './helpers/test-sshd.ts';

type SshResult = { code: number | null; stderr: string; stdout: Buffer };
type SshConnection = {
  alias: string;
  check: () => Promise<boolean>;
  ensureMaster: () => Promise<void>;
  exitMaster: () => Promise<void>;
  run: (remoteCommand: string, options?: { input?: string | Buffer }) => Promise<SshResult>;
  startMaster: () => Promise<void>;
};

const require = createRequire(import.meta.url);
const { createSshConnection } = require('../host/ssh-connection.cjs') as {
  createSshConnection: (options: {
    alias: string;
    controlDirectory?: string;
    sshConfigPath?: string;
  }) => SshConnection;
};

test('rejects destinations that ssh would parse as options', () => {
  expect(() =>
    createSshConnection({ alias: '-oProxyCommand=evil', controlDirectory: '/tmp' }),
  ).toThrow('Invalid SSH host: -oProxyCommand=evil');
  expect(() => createSshConnection({ alias: 'host:path', controlDirectory: '/tmp' })).toThrow();
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

  test('ensureMaster starts a master once for concurrent callers', async () => {
    await using sshd = await startTestSshd();
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    await Promise.all([
      connection.ensureMaster(),
      connection.ensureMaster(),
      connection.ensureMaster(),
    ]);
    expect(await connection.check()).toBe(true);
    await connection.exitMaster();
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
