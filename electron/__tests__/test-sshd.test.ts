import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
import { findSshd, startTestSshd } from './helpers/test-sshd.ts';

const roots = vi.hoisted(() => [] as Array<string>);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const path = await actual.mkdtemp(...args);
      roots.push(path);
      return path;
    },
  };
});

const execFileAsync = promisify(execFile);

afterEach(() => {
  vi.unstubAllEnvs();
  roots.length = 0;
});

test.runIf(Boolean(process.env.CI))('sshd is installed in CI', () => {
  expect(findSshd()).not.toBeNull();
});

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

  test('removes its temporary directory when startup fails', async () => {
    vi.stubEnv('PATH', '/nonexistent');
    await expect(startTestSshd()).rejects.toThrow();
    vi.unstubAllEnvs();
    expect(roots).toHaveLength(1);
    expect(existsSync(roots[0]!)).toBe(false);
  });
});
