// @ts-check

const { spawn } = require('node:child_process');
const { mkdirSync, readFileSync, rmSync } = require('node:fs');
const { connect } = require('node:net');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { classifySshFailure, HostUnreachableError } = require('./host-errors.cjs');

/**
 * @typedef {{
 *   alias: string;
 *   controlDirectory?: string;
 *   getLocalEnvironment?: () => NodeJS.ProcessEnv;
 *   masterStartTimeoutMs?: number;
 *   spawnProcess?: typeof spawn;
 *   sshCommand?: string;
 *   sshConfigPath?: string;
 * }} SshConnectionOptions
 * @typedef {{code: number | null; stderr: string; stdout: Buffer}} SshResult
 * @typedef {ReturnType<typeof createSshConnection>} SshConnection
 */

// A destination exactly as typed after `ssh`: an alias from ~/.ssh/config or
// user@host. A leading `-` would be parsed as an option, and ssh rejects a
// hostname starting with `-` (as in `a@-b`) before it opens the `-E` log, which
// would lose the error.
const ALIAS_PATTERN = /^(?!-)(?!.*@-)[\w.@%+-]+$/;

const getDefaultControlDirectory = () => join(homedir(), '.codiff', 'ssh');

/**
 * One multiplexed connection to an ssh destination. The master runs in the
 * background (`ControlPersist=yes`) and is the only invocation that connects
 * or reads the user's proxy settings. Every other invocation is a client that
 * only talks to the master: with no master, ssh falls back to connecting
 * itself, and the command-line `ProxyCommand=false` (which overrides any
 * configured `ProxyCommand` or `ProxyJump`) makes that fail at once with exit
 * 255. `BatchMode=yes` keeps every invocation from prompting.
 *
 * @param {SshConnectionOptions} options
 */
const createSshConnection = ({
  alias,
  controlDirectory = getDefaultControlDirectory(),
  getLocalEnvironment = () => process.env,
  masterStartTimeoutMs = 30_000,
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
  const clientArgs = [
    ...baseArgs,
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPersist=no',
    '-o',
    'ProxyCommand=false',
  ];

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

  const check = async () => (await runSsh([...baseArgs, '-O', 'check', '--', alias])).code === 0;

  /** @param {string} path */
  const isSocketStale = (path) =>
    new Promise((resolve) => {
      const socket = connect(path);
      socket.once('connect', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => resolve(true));
    });

  const readMasterLog = () => {
    try {
      return readFileSync(masterLogPath, 'utf8');
    } catch {
      return '';
    }
  };

  // ssh expands `%C` itself, so ask it for the exact socket path.
  const getControlPath = async () => {
    const { stdout } = await runSsh([...baseArgs, '-G', '--', alias]);
    const line = stdout
      .toString('utf8')
      .split('\n')
      .find((entry) => entry.startsWith('controlpath '));
    return line ? line.slice('controlpath '.length).trim() : null;
  };

  // `ssh -f` forks a master that keeps any inherited output pipes open, so the
  // master gets no pipes and writes its errors to a log file (`-E`) instead.
  // Starts from different Codiff instances for the same alias and control
  // directory are not coordinated. A start that loses the socket logs "already
  // exists, disabling multiplexing" and stays connected on its own; the check
  // after the start passes because the winner answers it.
  const startMaster = async () => {
    if (!(await check())) {
      // A killed master leaves its socket behind. ssh would then log "already
      // exists, disabling multiplexing" and still exit 0 with a lone `ssh -N`.
      const controlPath = await getControlPath();
      // Another master may have claimed the socket since the check, so only
      // remove one that nothing listens on.
      if (controlPath && (await isSocketStale(controlPath))) {
        rmSync(controlPath, { force: true });
      }
    }
    rmSync(masterLogPath, { force: true });
    /** @type {{code?: number | null; error?: string; timedOut?: boolean}} */
    const outcome = await new Promise((resolve) => {
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
          '--',
          alias,
        ],
        { env: getLocalEnvironment(), stdio: 'ignore' },
      );
      const timer = setTimeout(() => {
        child.kill();
        resolve({ timedOut: true });
      }, masterStartTimeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ error: error.message });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code });
      });
    });
    if (outcome.timedOut) {
      throw new HostUnreachableError(alias, `Timed out connecting to ${alias}.`);
    }
    if (outcome.error) {
      throw classifySshFailure(alias, outcome.error, { connected: false });
    }
    if (outcome.code !== 0) {
      throw classifySshFailure(alias, readMasterLog(), { connected: false });
    }
    if (!(await check())) {
      throw classifySshFailure(
        alias,
        readMasterLog() || 'The SSH master connection did not start.',
        { connected: false },
      );
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
    await runSsh([...baseArgs, '-O', 'exit', '--', alias]);
  };

  /** @param {string} remoteCommand @param {{input?: string | Buffer}} [options] */
  const run = (remoteCommand, options) =>
    runSsh([...clientArgs, '-T', '--', alias, remoteCommand], options);

  /** @param {string} remoteCommand @param {{tty?: boolean}} [options] */
  const spawnClient = (remoteCommand, { tty = false } = {}) =>
    spawnProcess(sshCommand, [...clientArgs, tty ? '-tt' : '-T', '--', alias, remoteCommand], {
      env: getLocalEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

  return { alias, check, ensureMaster, exitMaster, run, spawnClient, startMaster };
};

module.exports = { createSshConnection, getDefaultControlDirectory };
