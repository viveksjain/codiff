import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import packageJson from '../../package.json' with { type: 'json' };
import { createTemporaryDirectory } from './helpers/resources.ts';

const execFileAsync = promisify(execFile);

test.each([
  { args: [resolve('bin/codiff.js')], command: process.execPath, name: 'source CLI' },
  { args: [resolve('bin/codiff-app')], command: 'sh', name: 'terminal helper' },
])(
  '$name prints only its version despite an upstream update cached by an older app',
  async ({ args, command }) => {
    await using home = await createTemporaryDirectory('codiff-version-home-');
    const configDirectory = join(home.path, '.codiff');
    await mkdir(configDirectory);
    await writeFile(
      join(configDirectory, 'codiff.jsonc'),
      JSON.stringify({ settings: { checkForUpdates: true } }),
    );
    await writeFile(
      join(configDirectory, 'update-state.json'),
      JSON.stringify({
        compatible: true,
        lastCheckedAt: new Date().toISOString(),
        latestVersion: '99.0.0',
      }),
    );

    const { stderr, stdout } = await execFileAsync(command, [...args, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, CODIFF_NODE_COMMAND: process.execPath, HOME: home.path },
    });

    expect(stdout).toBe(`codiff v${packageJson.version}\n`);
    expect(stderr).toBe('');
  },
);
