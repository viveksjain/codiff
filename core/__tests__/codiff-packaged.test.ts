import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironment } from './helpers/git.ts';
import { createTemporaryDirectory } from './helpers/resources.ts';

const execFileAsync = promisify(execFile);

const createPackagedCli = async () => {
  const directory = await createTemporaryDirectory('codiff-packaged-');
  const appPath = join(directory.path, 'App with spaces/Codiff.app');
  const root = join(appPath, 'Contents/Resources/app');
  const executable = join(appPath, 'Contents/MacOS/codiff');
  const repositoryPath = join(await realpath(directory.path), 'repo with spaces');
  const launchFile = join(directory.path, 'launch.json');
  const command = join(directory.path, 'codiff');

  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(appPath, 'Contents/MacOS'), { recursive: true });
  await mkdir(repositoryPath);
  await cp(resolve('bin'), join(root, 'bin'), { recursive: true });
  await cp(resolve('package.json'), join(root, 'package.json'));
  await symlink(resolve('electron'), join(root, 'electron'));
  await writeFile(join(root, 'dist/index.html'), '<title>Codiff</title>');
  // Emulate Electron's two modes; run the real JavaScript CLI, recording only
  // the GUI process boundary so these tests do not open windows.
  await writeFile(
    executable,
    `#!${process.execPath}
if (process.env.ELECTRON_RUN_AS_NODE === '1') {
  process.argv.splice(1, 1);
  import(require('node:url').pathToFileURL(process.argv[1]).href);
} else {
  const fs = require('node:fs');
  fs.writeFileSync(process.env.CODIFF_TEST_LAUNCH_FILE, JSON.stringify({
    args: process.argv.slice(2), env: process.env,
  }));
  if (process.env.CODIFF_PLAN_RESULT_FILE) {
    fs.writeFileSync(process.env.CODIFF_PLAN_RESULT_FILE, JSON.stringify({pid: process.pid, status: 'open'}));
    setTimeout(() => fs.writeFileSync(process.env.CODIFF_PLAN_RESULT_FILE, JSON.stringify({documentChanged: true, status: process.env.CODIFF_TEST_PLAN_STATUS})), 100);
  }
}
`,
  );
  await chmod(executable, 0o755);
  await symlink(join(root, 'bin/codiff-app'), join(directory.path, 'app-cli'));
  await symlink('app-cli', command);
  await execFileAsync('git', ['init', repositoryPath], { env: getGitTestEnvironment() });
  for (const args of [
    ['commit', '--allow-empty', '-m', 'first'],
    ['branch', 'base'],
    ['commit', '--allow-empty', '-m', 'second'],
    ['branch', 'feature'],
  ]) {
    await execFileAsync('git', ['-C', repositoryPath, ...args], {
      env: getGitTestEnvironment(),
    });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODIFF_DEV_SERVER_URL: 'http://127.0.0.1:1',
    CODIFF_TEST_LAUNCH_FILE: launchFile,
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    PATH: '/usr/bin:/bin',
  };
  delete env.CODIFF_NODE_COMMAND;

  return {
    command,
    env,
    readLaunch: async () => JSON.parse(await readFile(launchFile, 'utf8')),
    repositoryPath,
    run: (args: ReadonlyArray<string>, cwd = repositoryPath) =>
      execFileAsync(command, args, { cwd, encoding: 'utf8', env }),
    async [Symbol.asyncDispose]() {
      await directory[Symbol.asyncDispose]();
    },
  };
};

test.each([
  { args: ['HEAD^1'], expected: { CODIFF_BRANCH_REF: 'HEAD^1', CODIFF_COMMIT_REF: '' } },
  { args: ['a1b2c3d4'], expected: { CODIFF_BRANCH_REF: 'a1b2c3d4', CODIFF_COMMIT_REF: '' } },
  { args: ['--commit', 'HEAD'], expected: { CODIFF_BRANCH_REF: '', CODIFF_COMMIT_REF: 'HEAD' } },
  { args: ['feature'], expected: { CODIFF_BRANCH_REF: 'feature', CODIFF_COMMIT_REF: '' } },
  { args: ['--branch=feature'], expected: { CODIFF_BRANCH_REF: 'feature' } },
  { args: ['base...feature'], expected: { CODIFF_BRANCH_REF: '', CODIFF_RANGE: 'base...feature' } },
  { args: ['base..feature'], expected: { CODIFF_BRANCH_REF: '', CODIFF_RANGE: 'base..feature' } },
  { args: ['base...missing'], expected: { CODIFF_BRANCH_REF: '', CODIFF_RANGE: '' } },
  { args: ['missing-branch'], expected: { CODIFF_BRANCH_REF: 'missing-branch' } },
  {
    args: ['https://github.com/nkzw-tech/codiff/pull/1728/changes#r4821'],
    expected: { CODIFF_PULL_REQUEST_URL: 'https://github.com/nkzw-tech/codiff/pull/1728' },
  },
  {
    args: ['https://gitlab.example.com/group/project/-/merge_requests/23/diffs#note_991'],
    expected: {
      CODIFF_PULL_REQUEST_URL: 'https://gitlab.example.com/group/project/-/merge_requests/23',
    },
  },
])('packaged CLI uses shared parsing for $args', async ({ args, expected }) => {
  await using cli = await createPackagedCli();

  await cli.run(args);

  await expect.poll(cli.readLaunch).toMatchObject({
    args: [],
    env: { ...expected, CODIFF_REPOSITORY_PATH: cli.repositoryPath },
  });
  const { env } = await cli.readLaunch();
  expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
});

test('packaged CLI resolves relative repositories and walkthrough metadata through symlinks', async () => {
  await using cli = await createPackagedCli();
  const repositoryPath = join(cli.repositoryPath, 'nested');
  await mkdir(repositoryPath);

  await cli.run([
    '-w',
    '--agent',
    'claude',
    '--claude-session',
    'claude-session',
    '--codex-session',
    'codex-session',
    '--opencode-session',
    'opencode-session',
    '--pi-session',
    'pi-session',
    '--walkthrough-context',
    'seed.json',
    '--walkthrough-file',
    'narrative.json',
    'nested',
  ]);

  await expect.poll(cli.readLaunch).toMatchObject({
    env: {
      CODIFF_AGENT_BACKEND: 'claude',
      CODIFF_CLAUDE_SESSION_ID: 'claude-session',
      CODIFF_CODEX_SESSION_ID: 'codex-session',
      CODIFF_OPENCODE_SESSION_ID: 'opencode-session',
      CODIFF_PI_SESSION_ID: 'pi-session',
      CODIFF_REPOSITORY_PATH: repositoryPath,
      CODIFF_WALKTHROUGH: '1',
      CODIFF_WALKTHROUGH_CONTEXT: join(cli.repositoryPath, 'seed.json'),
      CODIFF_WALKTHROUGH_FILE: join(cli.repositoryPath, 'narrative.json'),
    },
  });
});

test.each([
  { status: 'done', stdout: 'CODIFF_PLAN_RESULT {"documentChanged":true,"status":"done"}\n' },
  { status: 'closed', stdout: 'CODIFF_PLAN_RESULT {"documentChanged":true,"status":"closed"}\n' },
  { status: 'canceled', stdout: '' },
])('packaged CLI waits for a $status plan result', async ({ status, stdout }) => {
  await using cli = await createPackagedCli();
  const planFile = join(cli.repositoryPath, 'plan.md');
  await writeFile(planFile, '# Plan\n');
  cli.env.CODIFF_TEST_PLAN_STATUS = status;
  const invocation = cli.run(['--plan', 'plan.md']);

  if (status === 'canceled') {
    await expect(invocation).rejects.toMatchObject({ code: 2, stdout });
  } else {
    expect((await invocation).stdout).toBe(stdout);
  }
  const { env } = await cli.readLaunch();
  expect(env.CODIFF_PLAN_FILE).toBe(planFile);
  expect(env.CODIFF_PLAN_RESULT_FILE).toBeTruthy();
  await expect(readFile(env.CODIFF_PLAN_RESULT_FILE)).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['--help', '--version', '--walkthrough-guide', '--completions=zsh'])(
  'packaged CLI produces the same %s output as the source CLI',
  async (arg) => {
    await using cli = await createPackagedCli();
    const [packaged, source] = await Promise.all([
      cli.run([arg]),
      execFileAsync(process.execPath, [resolve('bin/codiff.js'), arg], {
        cwd: cli.repositoryPath,
        encoding: 'utf8',
        env: cli.env,
      }),
    ]);

    expect(packaged.stdout).toBe(source.stdout);
    expect(packaged.stderr).toBe(source.stderr);
    await expect(cli.readLaunch()).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

test('packaged CLI preserves shared validation errors and exit status', async () => {
  await using cli = await createPackagedCli();

  await expect(cli.run(['--completions=unsupported'])).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('unsupported shell for --completions'),
  });
  await expect(cli.readLaunch()).rejects.toMatchObject({ code: 'ENOENT' });
});
