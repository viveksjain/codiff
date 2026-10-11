import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vite-plus/test';
import { findSshd, startTestSshd } from './helpers/test-sshd.ts';

const execFileAsync = promisify(execFile);

describe.skipIf(!findSshd())('test sshd', () => {
  test('accepts the generated key and forwards Git variables', async () => {
    await using sshd = await startTestSshd();
    const { stdout } = await execFileAsync(
      'ssh',
      [
        '-F',
        sshd.sshConfigPath,
        '-o',
        'BatchMode=yes',
        sshd.alias,
        'echo ok; echo "$GIT_CODIFF_HARNESS"',
      ],
      { env: { ...process.env, GIT_CODIFF_HARNESS: 'forwarded' } },
    );
    expect(stdout).toBe('ok\nforwarded\n');
  });

  test('rejects an unauthorized key', async () => {
    await using sshd = await startTestSshd({ authorize: false });
    await expect(
      execFileAsync('ssh', ['-F', sshd.sshConfigPath, '-o', 'BatchMode=yes', sshd.alias, 'true']),
    ).rejects.toThrow(/Permission denied/);
  });

  test('provides an alias for a port nothing listens on', async () => {
    await using sshd = await startTestSshd();
    await expect(
      execFileAsync('ssh', [
        '-F',
        sshd.sshConfigPath,
        '-o',
        'BatchMode=yes',
        sshd.unreachableAlias,
        'true',
      ]),
    ).rejects.toThrow(/Connection refused/);
  });
});
