// @ts-check

const { EventEmitter } = require('node:events');
const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const {
  RemoteCommandMissingError,
  RemoteShellNoiseError,
  UnsupportedRemoteShellError,
  classifySshFailure,
} = require('./host-errors.cjs');
const {
  PID_MARKER,
  buildCommandScript,
  getShellDialect,
  wrapForLoginShell,
} = require('./shell-quote.cjs');
const { createSshConnection } = require('./ssh-connection.cjs');

/**
 * @typedef {import('./repository-host.cjs').HostPty} HostPty
 * @typedef {import('./repository-host.cjs').HostStat} HostStat
 * @typedef {import('./repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {import('./shell-quote.cjs').ShellDialect} ShellDialect
 * @typedef {import('./ssh-connection.cjs').SshConnection} SshConnection
 * @typedef {import('./ssh-connection.cjs').SshConnectionOptions} SshConnectionOptions
 * @typedef {import('./ssh-connection.cjs').SshResult} SshResult
 * @typedef {'bsd' | 'gnu'} StatFlavor
 * @typedef {RepositoryHost & {close: () => Promise<void>}} SshHost
 */

const DEFAULT_MAX_BUFFER = 1024 * 1024 * 64;
// sshd allows 10 sessions per connection by default (MaxSessions). Queued
// operations use at most 6, leaving room for long-lived spawns, a commit PTY,
// remote kill requests and a fallback session.
const MAX_QUEUED_CHANNELS = 6;
const SHELL_PROBE_PREFIX = '__codiff_shell__:';
// How long a kill waits for the command to announce its PID.
const PID_WAIT_MS = 5000;

/** @param {number} limit */
const createLimiter = (limit) => {
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];
  const acquire = () =>
    active < limit
      ? ((active += 1), Promise.resolve())
      : new Promise((resolve) => waiting.push(() => resolve(undefined)));
  // A finished task hands its slot straight to the next waiter.
  const release = () => {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      active -= 1;
    }
  };
  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  return async (task) => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
};

const createAbortError = () => {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
};

/**
 * Strips a leading `PID_MARKER<pid>` line (as printed by `buildCommandScript`
 * with `announcePid`) from a stream and reports the PID.
 *
 * @param {(pid: number) => void} onPid
 */
const createPidMarkerFilter = (onPid) => {
  let pending = Buffer.alloc(0);
  let done = false;
  return new Transform({
    flush(callback) {
      callback(null, done || pending.length === 0 ? undefined : pending);
    },
    transform(chunk, _encoding, callback) {
      if (done) {
        callback(null, chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(10);
      if (newline === -1) {
        if (pending.length > PID_MARKER.length + 32) {
          done = true;
          callback(null, pending);
        } else {
          callback();
        }
        return;
      }
      done = true;
      const line = pending.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      if (line.startsWith(PID_MARKER)) {
        const pid = Number(line.slice(PID_MARKER.length));
        if (Number.isSafeInteger(pid) && pid > 0) {
          onPid(pid);
        }
        const rest = pending.subarray(newline + 1);
        callback(null, rest.length > 0 ? rest : undefined);
      } else {
        callback(null, pending);
      }
    },
  });
};

/**
 * @param {{
 *   alias: string;
 *   connection: SshConnection;
 *   dialect: ShellDialect;
 *   masterCheckIntervalMs?: number;
 *   statFlavor: StatFlavor;
 * }} options
 * @returns {SshHost}
 */
const createSshHost = ({
  alias,
  connection,
  dialect,
  masterCheckIntervalMs = 5000,
  statFlavor,
}) => {
  const limit = createLimiter(MAX_QUEUED_CHANNELS);
  let lastMasterCheck = 0;
  let closed = false;
  /** @type {Promise<void> | null} */
  let restoringMaster = null;

  // A client whose master vanished connects on its own (ControlMaster=auto);
  // this restores a shared master in the background. `close` waits for it, so
  // a restore cannot leave a master running after the host is closed.
  const restoreMaster = () => {
    if (closed || restoringMaster) {
      return;
    }
    restoringMaster = connection
      .ensureMaster()
      .catch(() => {})
      .finally(() => {
        restoringMaster = null;
      });
  };

  const keepMasterAlive = () => {
    const now = Date.now();
    if (now - lastMasterCheck >= masterCheckIntervalMs) {
      lastMasterCheck = now;
      restoreMaster();
    }
  };

  /** @param {string} script */
  const toRemoteCommand = (script) => wrapForLoginShell(script, dialect);

  // Closing the local ssh client does not stop the remote process.
  // The PID is announced before `exec`, so if `exec` itself fails the PID is
  // already dead and could in theory be reused; it is only killed on cancel.
  /** @param {number} pid */
  const killRemote = (pid) => {
    const child = connection.spawnClient(
      toRemoteCommand(`kill -TERM ${Math.trunc(pid)} 2>/dev/null; :`),
    );
    child.on('error', () => {});
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.end();
  };

  /**
   * Stops one command: its local ssh client and, by its announced PID, the
   * remote process. Stopping is idempotent and never targets a PID after the
   * command exited, since the PID may belong to another process by then.
   *
   * Killing the client while the master is still setting up the session leaves
   * that session running and holding the client's pipes until the remote
   * process exits, with no PID to kill it by. Until the PID is announced, the
   * client is therefore only killed once it arrives (or after a timeout).
   *
   * @param {import('node:child_process').ChildProcess} child
   */
  const createRemoteProcess = (child) => {
    /** @type {number | null} */
    let pid = null;
    let killed = false;
    let exited = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const killNow = () => {
      clearTimeout(timer);
      child.kill();
      if (pid != null) {
        killRemote(pid);
      }
    };
    return {
      /** @param {number} value */
      announce: (value) => {
        pid = value;
        if (killed && !exited) {
          killNow();
        }
      },
      exit: () => {
        exited = true;
        clearTimeout(timer);
      },
      kill: () => {
        if (killed || exited) {
          return;
        }
        killed = true;
        if (pid != null) {
          killNow();
        } else {
          timer = setTimeout(killNow, PID_WAIT_MS);
        }
      },
    };
  };

  /**
   * Exit 255 is either an ssh failure or a command that exited 255. Only a
   * dead master makes it an ssh failure.
   *
   * @param {SshResult} result
   * @returns {Promise<Error | null>}
   */
  const getConnectionError = async (result) => {
    if (result.code !== 255 || (await connection.check())) {
      return null;
    }
    restoreMaster();
    return classifySshFailure(alias, result.stderr);
  };

  /**
   * @param {string} script
   * @param {{input?: string | Buffer; label?: string; maxBuffer?: number; signal?: AbortSignal}} [options]
   * @returns {Promise<SshResult>}
   */
  const runScript = (
    script,
    { input, label = 'ssh', maxBuffer = DEFAULT_MAX_BUFFER, signal } = {},
  ) =>
    limit(
      () =>
        new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(createAbortError());
            return;
          }
          keepMasterAlive();
          const child = connection.spawnClient(toRemoteCommand(script));
          const remote = createRemoteProcess(child);
          const stderrFilter = createPidMarkerFilter(remote.announce);
          /** @type {Array<Buffer>} */
          const stdout = [];
          /** @type {Array<Buffer>} */
          const stderr = [];
          let stdoutBytes = 0;
          let settled = false;
          /** @type {number | null | undefined} */
          let exitCode;
          let stderrEnded = false;

          const abort = () => {
            remote.kill();
            fail(createAbortError());
          };
          const cleanup = () => signal?.removeEventListener('abort', abort);
          /** @param {Error} error */
          const fail = (error) => {
            if (!settled) {
              settled = true;
              cleanup();
              reject(error);
            }
          };
          const finish = () => {
            if (!settled && exitCode !== undefined && stderrEnded) {
              settled = true;
              cleanup();
              resolve({
                code: exitCode,
                stderr: Buffer.concat(stderr).toString('utf8'),
                stdout: Buffer.concat(stdout),
              });
            }
          };

          signal?.addEventListener('abort', abort, { once: true });
          child.stdout.on('data', (chunk) => {
            if (settled) {
              return;
            }
            stdoutBytes += chunk.length;
            if (stdoutBytes > maxBuffer) {
              remote.kill();
              fail(new Error(`${label} output exceeded ${maxBuffer} bytes.`));
              return;
            }
            stdout.push(chunk);
          });
          child.stderr.pipe(stderrFilter);
          stderrFilter.on('data', (chunk) => stderr.push(chunk));
          stderrFilter.on('end', () => {
            stderrEnded = true;
            finish();
          });
          child.stdin.on('error', (error) => {
            if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EPIPE') {
              fail(error);
            }
          });
          child.on('error', fail);
          child.on('close', (code) => {
            remote.exit();
            exitCode = code;
            finish();
          });
          child.stdin.end(input);
        }),
    );

  /** @type {RepositoryHost['exec']} */
  const exec = async (command, args, options = {}) => {
    const result = await runScript(
      buildCommandScript({ announcePid: true, args, command, cwd: options.cwd, env: options.env }),
      {
        input: options.input,
        label: command,
        maxBuffer: options.maxBuffer,
        signal: options.signal,
      },
    );
    if (result.code === 0) {
      return result.stdout;
    }
    const connectionError = await getConnectionError(result);
    if (connectionError) {
      throw connectionError;
    }
    throw new Error(
      options.input === undefined
        ? `Command failed: ${[command, ...args].join(' ')}\n${result.stderr}`
        : result.stderr || `${command} exited with status ${result.code}`,
    );
  };

  /** @type {RepositoryHost['spawn']} */
  const spawn = (command, args, options = {}) => {
    keepMasterAlive();
    const child = connection.spawnClient(
      toRemoteCommand(
        buildCommandScript({
          announcePid: true,
          args,
          command,
          cwd: options.cwd,
          env: options.env,
        }),
      ),
    );
    const remote = createRemoteProcess(child);
    const stderr = createPidMarkerFilter(remote.announce);
    child.stderr.pipe(stderr);
    /** @type {number | null | undefined} */
    let exitCode;
    /** @type {NodeJS.Signals | null} */
    let exitSignal = null;
    let stderrFinished = false;
    const hostProcess = Object.assign(new EventEmitter(), {
      kill: () => {
        remote.kill();
        return true;
      },
      stderr,
      stdin: child.stdin,
      stdout: child.stdout,
    });
    // Emit 'close' only after the filtered stderr has received everything.
    const emitClose = () => {
      if (exitCode !== undefined && stderrFinished) {
        setImmediate(() => hostProcess.emit('close', exitCode, exitSignal));
      }
    };
    stderr.on('finish', () => {
      stderrFinished = true;
      emitClose();
    });
    child.on('close', (code, signal) => {
      remote.exit();
      exitCode = code;
      exitSignal = signal;
      emitClose();
    });
    child.on('error', (error) => hostProcess.emit('error', error));
    return hostProcess;
  };

  /** @type {RepositoryHost['spawnPty']} */
  const spawnPty = (command, args, options) => {
    keepMasterAlive();
    const script = `stty cols ${Math.trunc(options.cols)} rows ${Math.trunc(options.rows)} 2>/dev/null; ${buildCommandScript(
      {
        announcePid: true,
        args,
        command,
        cwd: options.cwd,
        env: { ...options.env, TERM: options.name },
      },
    )}`;
    const child = connection.spawnClient(toRemoteCommand(script), { tty: true });
    const remote = createRemoteProcess(child);
    const output = createPidMarkerFilter(remote.announce);
    const decoder = new StringDecoder('utf8');
    /** @type {Set<(data: string) => void>} */
    const dataListeners = new Set();
    /** @type {Set<(event: {exitCode: number}) => void>} */
    const exitListeners = new Set();
    /** @type {number | null | undefined} */
    let exitCode;
    let outputEnded = false;
    let exited = false;

    /** @param {string} text */
    const emitData = (text) => {
      if (text) {
        for (const listener of dataListeners) {
          listener(text);
        }
      }
    };
    const emitExit = () => {
      if (exited || exitCode === undefined || !outputEnded) {
        return;
      }
      exited = true;
      emitData(decoder.end());
      child.stdin.end();
      for (const listener of exitListeners) {
        listener({ exitCode: exitCode ?? 1 });
      }
    };

    child.stdout.pipe(output);
    output.on('data', (chunk) => emitData(decoder.write(chunk)));
    output.on('end', () => {
      outputEnded = true;
      emitExit();
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      remote.exit();
      exitCode = code;
      emitExit();
    });
    child.on('error', () => {
      exitCode = 1;
      outputEnded = true;
      emitExit();
    });

    /** @type {HostPty} */
    const pty = {
      kill: () => {
        remote.kill();
      },
      onData: (listener) => {
        dataListeners.add(listener);
        return { dispose: () => void dataListeners.delete(listener) };
      },
      onExit: (listener) => {
        exitListeners.add(listener);
        return { dispose: () => void exitListeners.delete(listener) };
      },
    };
    return pty;
  };

  const notImplemented = () => Promise.reject(new Error('Not implemented yet.'));

  return Object.freeze({
    close: async () => {
      closed = true;
      await restoringMaster;
      await connection.exitMaster();
    },
    exec,
    id: `ssh://${alias}`,
    label: alias,
    lstat: notImplemented,
    lstatMany: notImplemented,
    mkdtemp: notImplemented,
    readFile: notImplemented,
    readFiles: notImplemented,
    readlink: notImplemented,
    realpath: notImplemented,
    rename: notImplemented,
    rm: notImplemented,
    spawn,
    spawnPty,
    stat: notImplemented,
    writeFile: notImplemented,
  });
};

/**
 * Connects to an ssh destination: adopts or starts the master, picks the
 * escaping dialect from the login shell, and checks the remote tools.
 *
 * @param {SshConnectionOptions & {connection?: SshConnection; masterCheckIntervalMs?: number}} options
 * @returns {Promise<SshHost>}
 */
const connectSshHost = async ({
  connection: providedConnection,
  masterCheckIntervalMs,
  ...options
}) => {
  const connection = providedConnection ?? createSshConnection(options);
  const { alias } = connection;
  await connection.ensureMaster();

  // The login shell parses this one fixed command; it is valid in every shell.
  const shellResult = await connection.run(`printf '${SHELL_PROBE_PREFIX}%s\\n' "$SHELL"`);
  if (shellResult.code !== 0) {
    throw classifySshFailure(alias, shellResult.stderr, { connected: false });
  }
  const shellLines = shellResult.stdout.toString('utf8').split('\n').filter(Boolean);
  if (shellLines.length !== 1 || !shellLines[0].startsWith(SHELL_PROBE_PREFIX)) {
    throw new RemoteShellNoiseError(alias);
  }
  const shell = shellLines[0].slice(SHELL_PROBE_PREFIX.length);
  const dialect = getShellDialect(shell);
  if (!dialect) {
    throw new UnsupportedRemoteShellError(alias, shell);
  }

  const probe = await connection.run(
    wrapForLoginShell(
      'if stat --version >/dev/null 2>&1; then echo gnu; else echo bsd; fi; for c in git realpath; do command -v "$c" >/dev/null 2>&1 || echo "missing:$c"; done',
      dialect,
    ),
  );
  if (probe.code !== 0) {
    throw classifySshFailure(alias, probe.stderr, { connected: false });
  }
  const probeLines = probe.stdout.toString('utf8').split('\n').filter(Boolean);
  const missing = probeLines.find((line) => line.startsWith('missing:'));
  if (missing) {
    throw new RemoteCommandMissingError(alias, missing.slice('missing:'.length));
  }
  return createSshHost({
    alias,
    connection,
    dialect,
    masterCheckIntervalMs,
    statFlavor: probeLines[0] === 'gnu' ? 'gnu' : 'bsd',
  });
};

module.exports = { connectSshHost, createPidMarkerFilter, createSshHost };
