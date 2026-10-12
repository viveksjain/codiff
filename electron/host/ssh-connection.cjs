// @ts-check

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdirSync, rmSync } = require('node:fs');
const { connect } = require('node:net');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { classifySshFailure, HostUnreachableError } = require('./host-errors.cjs');

/**
 * @typedef {{
 *   alias: string;
 *   controlDirectory?: string;
 *   getLocalEnvironment?: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
 *   interactive?: boolean;
 *   port?: number;
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
// hostname starting with `-` (as in `a@-b`).
const ALIAS_PATTERN = /^(?!-)(?!.*@-)[\w.@%+-]+$/;

const getDefaultControlDirectory = () => join(homedir(), '.codiff', 'ssh');

/**
 * A control socket is stale only when nothing listens on it or it is gone.
 * Any other error, or no answer in time, leaves it alone, since it may still
 * belong to a live master.
 *
 * @param {string} path
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
const isSocketStale = (path, timeoutMs = 1500) =>
  new Promise((resolve) => {
    const socket = connect(path);
    /** @param {boolean} stale */
    const finish = (stale) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(stale);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(false));
    socket.once('error', (/** @type {NodeJS.ErrnoException} */ error) =>
      finish(error.code === 'ECONNREFUSED' || error.code === 'ENOENT'),
    );
  });

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
  interactive = false,
  port,
  masterStartTimeoutMs = 30_000,
  spawnProcess = spawn,
  sshCommand = 'ssh',
  sshConfigPath,
}) => {
  if (!(ALIAS_PATTERN.test(alias) || /^(?:[\w.%+-]+@)?[a-fA-F0-9]*:[a-fA-F0-9:]+$/.test(alias))) {
    throw new Error(`Invalid SSH host: ${alias}`);
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`Invalid SSH port: ${port}`);
  }
  mkdirSync(controlDirectory, { mode: 0o700, recursive: true });
  const baseArgs = [
    ...(sshConfigPath ? ['-F', sshConfigPath] : []),
    ...(port !== undefined ? ['-p', String(port)] : []),
    // -S takes the path directly, without ssh_config's quote parsing. Only the
    // final %C is a token; percent signs in the directory are literal.
    '-S',
    join(controlDirectory.replaceAll('%', '%%'), '%C'),
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    `BatchMode=${interactive ? 'no' : 'yes'}`,
    '-o',
    // Preserve transport diagnostics, including mux-only and proxy failures.
    'LogLevel=INFO',
    // These settings must apply to the master as well as clients.
    '-o',
    'RemoteCommand=none',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'PermitLocalCommand=no',
  ];
  const controlPathArgument = baseArgs.indexOf('-S') + 1;
  /** @type {string | null} */
  let resolvedControlPath = null;
  const getClientArgs = () => [
    ...baseArgs,
    // %C includes ProxyJump on newer OpenSSH. ProxyCommand=false clears that
    // setting, so clients must use the path expanded from the master's config.
    ...(resolvedControlPath ? ['-S', resolvedControlPath.replaceAll('%', '%%')] : []),
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPersist=no',
    '-o',
    'ProxyCommand=false',
  ];

  /** @type {NodeJS.ProcessEnv | null} */
  let localEnvironment = null;
  /** @type {Promise<NodeJS.ProcessEnv> | null} */
  let pendingEnvironment = null;
  const prepareEnvironment = async () => {
    pendingEnvironment ??= Promise.resolve()
      .then(getLocalEnvironment)
      .then((env) => (localEnvironment = env));
    await pendingEnvironment;
  };

  /**
   * @param {ReadonlyArray<string>} args
   * @param {{input?: string | Buffer}} [options]
   * @returns {Promise<SshResult>}
   */
  const runSsh = async (args, { input } = {}) => {
    await prepareEnvironment();
    return new Promise((resolve) => {
      const child = spawnProcess(sshCommand, [...args], {
        env: localEnvironment ?? process.env,
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
  };

  // ssh expands `%C` itself, so ask it for the exact socket path.
  /** @type {Promise<string | null> | null} */
  let pendingControlPath = null;
  const getControlPath = () => {
    if (resolvedControlPath) {
      return Promise.resolve(resolvedControlPath);
    }
    pendingControlPath ??= (async () => {
      try {
        const { stdout } = await runSsh([...baseArgs, '-G', '--', alias]);
        const line = stdout
          .toString('utf8')
          .split('\n')
          .find((entry) => entry.startsWith('controlpath '));
        if (line) {
          // Registry leases are scoped to the typed alias and explicit port,
          // while %C merges aliases for one endpoint. Hash both identities into
          // the original 40-byte filename budget, including space for OpenSSH's
          // temporary bind suffix on macOS. The CLI and GUI derive the same path.
          const destinationKey = createHash('sha256')
            .update(JSON.stringify([alias, port ?? null, line.slice('controlpath '.length).trim()]))
            .digest('hex')
            .slice(0, 40);
          resolvedControlPath = join(controlDirectory, destinationKey);
          baseArgs[controlPathArgument] = resolvedControlPath.replaceAll('%', '%%');
        }
        return resolvedControlPath;
      } finally {
        pendingControlPath = null;
      }
    })();
    return pendingControlPath;
  };

  const check = async () => {
    await getControlPath();
    return (await runSsh([...baseArgs, '-O', 'check', '--', alias])).code === 0;
  };

  // ControlPersist backgrounds a master only after it binds the mux socket,
  // and closes its inherited pipes. Without explicit -f, a start that loses
  // the socket stays our child: stop that child and adopt the winning master.
  // This preserves process ownership even when separate Codiff instances race.
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
    let stderr = '';
    let lostSocket = false;
    /** @type {{code?: number | null; error?: string; timedOut?: boolean}} */
    const outcome = await new Promise((resolve) => {
      const child = spawnProcess(
        sshCommand,
        [
          ...baseArgs,
          '-o',
          'ControlMaster=yes',
          '-o',
          'ControlPersist=yes',
          '-o',
          // Override ForkAfterAuthentication from config, too, so a loser
          // cannot daemonize before we stop it by its direct child handle.
          'ForkAfterAuthentication=no',
          '-N',
          '--',
          alias,
        ],
        { env: localEnvironment ?? process.env, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        if (interactive) {
          process.stderr.write(chunk);
        }
        if (!lostSocket && /ControlSocket .* already exists, disabling multiplexing/.test(stderr)) {
          lostSocket = true;
          child.kill();
        }
      });
      // An interactive login waits on the user (passwords, 2FA, host keys).
      const timer = interactive
        ? undefined
        : setTimeout(() => {
            child.kill();
            resolve({ timedOut: true });
          }, masterStartTimeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ error: error.message });
      });
      // close drains ssh's transport diagnostics before classification.
      child.on('close', (code) => {
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
    if (outcome.code !== 0 && !lostSocket) {
      throw classifySshFailure(alias, stderr, { connected: false });
    }
    if (!(await check())) {
      throw classifySshFailure(alias, stderr || 'The SSH master connection did not start.', {
        connected: false,
      });
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
    await getControlPath();
    await runSsh([...baseArgs, '-O', 'exit', '--', alias]);
  };

  /** @param {string} remoteCommand @param {{input?: string | Buffer}} [options] */
  const run = async (remoteCommand, options) => {
    await getControlPath();
    return runSsh([...getClientArgs(), '-T', '--', alias, remoteCommand], options);
  };

  /**
   * The host checks/starts the connection before synchronously spawning clients.
   * @param {string} remoteCommand @param {{tty?: boolean}} [options]
   */
  const spawnClient = (remoteCommand, { tty = false } = {}) =>
    spawnProcess(sshCommand, [...getClientArgs(), tty ? '-tt' : '-T', '--', alias, remoteCommand], {
      env: localEnvironment ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

  return { alias, port, check, ensureMaster, exitMaster, run, spawnClient, startMaster };
};

module.exports = { createSshConnection, getDefaultControlDirectory, isSocketStale };
