// @ts-check

const { spawn } = require('node:child_process');
const { mkdirSync, readFileSync, rmSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { classifySshFailure } = require('./host-errors.cjs');

/**
 * @typedef {{
 *   alias: string;
 *   controlDirectory?: string;
 *   getLocalEnvironment?: () => NodeJS.ProcessEnv;
 *   spawnProcess?: typeof spawn;
 *   sshCommand?: string;
 *   sshConfigPath?: string;
 * }} SshConnectionOptions
 * @typedef {{code: number | null; stderr: string; stdout: Buffer}} SshResult
 * @typedef {ReturnType<typeof createSshConnection>} SshConnection
 */

// A destination exactly as typed after `ssh`: an alias from ~/.ssh/config or
// user@host. A leading `-` would be parsed as an option.
const ALIAS_PATTERN = /^(?!-)[\w.@%+-]+$/;

const getDefaultControlDirectory = () => join(homedir(), '.codiff', 'ssh');

/**
 * One multiplexed connection to an ssh destination. The master runs in the
 * background (`ControlPersist=yes`); every other invocation is a client with
 * `ControlMaster=auto`, so if the master is gone a client connects on its own
 * instead of failing. `BatchMode=yes` keeps every invocation from prompting.
 *
 * @param {SshConnectionOptions} options
 */
const createSshConnection = ({
  alias,
  controlDirectory = getDefaultControlDirectory(),
  getLocalEnvironment = () => process.env,
  spawnProcess = spawn,
  sshCommand = 'ssh',
  sshConfigPath,
}) => {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new Error(`Invalid SSH host: ${alias}`);
  }
  mkdirSync(controlDirectory, { mode: 0o700, recursive: true });
  const masterLogPath = join(controlDirectory, `${alias}.log`);
  const baseArgs = [
    ...(sshConfigPath ? ['-F', sshConfigPath] : []),
    '-o',
    `ControlPath=${join(controlDirectory, '%C')}`,
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'BatchMode=yes',
    '-o',
    'LogLevel=ERROR',
  ];
  const clientArgs = [...baseArgs, '-o', 'ControlMaster=auto', '-o', 'ControlPersist=no'];

  /**
   * @param {ReadonlyArray<string>} args
   * @param {{input?: string | Buffer}} [options]
   * @returns {Promise<SshResult>}
   */
  const runSsh = (args, { input } = {}) =>
    new Promise((resolve) => {
      const child = spawnProcess(sshCommand, [...args], {
        env: getLocalEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      /** @type {Array<Buffer>} */
      const stdout = [];
      /** @type {Array<Buffer>} */
      const stderr = [];
      let done = false;
      /** @param {number | null} code */
      const finish = (code) => {
        if (!done) {
          done = true;
          resolve({
            code,
            stderr: Buffer.concat(stderr).toString('utf8'),
            stdout: Buffer.concat(stdout),
          });
        }
      };
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.stdin.on('error', () => {});
      child.on('error', (error) => {
        stderr.push(Buffer.from(error.message));
        finish(null);
      });
      child.on('close', finish);
      child.stdin.end(input);
    });

  const check = async () => (await runSsh([...baseArgs, '-O', 'check', alias])).code === 0;

  const readMasterLog = () => {
    try {
      return readFileSync(masterLogPath, 'utf8');
    } catch {
      return '';
    }
  };

  // `ssh -f` forks a master that keeps any inherited output pipes open, so the
  // master gets no pipes and writes its errors to a log file (`-E`) instead.
  const startMaster = async () => {
    rmSync(masterLogPath, { force: true });
    /** @type {number | null} */
    const code = await new Promise((resolve) => {
      const child = spawnProcess(
        sshCommand,
        [
          ...baseArgs,
          '-E',
          masterLogPath,
          '-o',
          'ControlMaster=yes',
          '-o',
          'ControlPersist=yes',
          '-f',
          '-N',
          alias,
        ],
        { env: getLocalEnvironment(), stdio: 'ignore' },
      );
      child.on('error', () => resolve(null));
      child.on('exit', resolve);
    });
    if (code !== 0) {
      throw classifySshFailure(alias, readMasterLog(), { connected: false });
    }
  };

  /** @type {Promise<void> | null} */
  let pendingMaster = null;
  const ensureMaster = () => {
    pendingMaster ??= (async () => {
      try {
        if (!(await check())) {
          await startMaster();
        }
      } finally {
        pendingMaster = null;
      }
    })();
    return pendingMaster;
  };

  const exitMaster = async () => {
    await runSsh([...baseArgs, '-O', 'exit', alias]);
  };

  /** @param {string} remoteCommand @param {{input?: string | Buffer}} [options] */
  const run = (remoteCommand, options) =>
    runSsh([...clientArgs, '-T', alias, remoteCommand], options);

  /** @param {string} remoteCommand @param {{tty?: boolean}} [options] */
  const spawnClient = (remoteCommand, { tty = false } = {}) =>
    spawnProcess(sshCommand, [...clientArgs, tty ? '-tt' : '-T', alias, remoteCommand], {
      env: getLocalEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

  return { alias, check, ensureMaster, exitMaster, run, spawnClient, startMaster };
};

module.exports = { createSshConnection, getDefaultControlDirectory };
