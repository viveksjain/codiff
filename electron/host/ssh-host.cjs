// @ts-check

const { EventEmitter } = require('node:events');
const { constants } = require('node:os');
const { PassThrough, Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const {
  HostDisconnectedError,
  RemoteCommandMissingError,
  RemoteShellNoiseError,
  UnsupportedRemoteShellError,
  classifySshFailure,
} = require('./host-errors.cjs');
const {
  PID_MARKER,
  buildCommandScript,
  getShellDialect,
  quoteFish,
  quotePosix,
  wrapForLoginShell,
} = require('./shell-quote.cjs');
const { getSshHostId } = require('./repository-target.cjs');
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
 * @typedef {'connected' | 'disconnected' | 'closed'} ConnectionState
 * @typedef {RepositoryHost & {close: () => Promise<void>; reconnect: () => Promise<void>; getConnectionState: () => ConnectionState; onConnectionState: (listener: (state: ConnectionState) => void) => () => void}} SshHost
 * @typedef {import('node:child_process').ChildProcessWithoutNullStreams & {cancelQueued: () => boolean}} QueuedChild
 */

const DEFAULT_MAX_BUFFER = 1024 * 1024 * 64;
// All commands, file operations and PTYs share six sessions. One separate
// cancellation session ensures they can always be stopped under MaxSessions=10.
const MAX_QUEUED_CHANNELS = 6;
const SHELL_PROBE_PREFIX = '__codiff_shell__:';
// How long a kill waits for the command to announce its PID.
const PID_WAIT_MS = 5000;
// Linux caps one argument (the remote command string) at 128 KiB. A batch's
// wrapped remote command stays below half of that; its paths get all but a
// reserve for the fixed parts of the script.
const MAX_BATCH_SCRIPT_BYTES = 64 * 1024;
const MAX_BATCH_PATH_BYTES = MAX_BATCH_SCRIPT_BYTES - 4 * 1024;
// GNU stat prints the locale's decimal point (`1700000000,5` under de_DE), and
// ssh forwards LANG and LC_* by default, so every stat runs in the C locale.
const C_LOCALE = 'export LC_ALL=C';
// Mode (raw, in hex), size, inode, and modification and change times in seconds
// with nanoseconds. GNU's `%.9Y` precision needs coreutils 8.x or later.
/** @type {Record<StatFlavor, string>} */
const STAT_FORMATS = {
  bsd: "-f '%Xp %z %i %Fm %Fc'",
  gnu: "-c '%f %s %i %.9Y %.9Z'",
};

/** @param {string} line @returns {HostStat} */
const parseStatLine = (line) => {
  const fields = line.trim().split(' ');
  const [mode, size, ino, mtime, ctime] = fields;
  const modeNumber = Number.parseInt(mode, 16);
  const stat = {
    ctimeMs: Number(ctime) * 1000,
    ino: Number(ino),
    mode: modeNumber,
    mtimeMs: Number(mtime) * 1000,
    size: Number(size),
  };
  if (fields.length !== 5 || Object.values(stat).some(Number.isNaN)) {
    throw new Error('Unexpected stat output.');
  }
  const typeBits = modeNumber & 0o170000;
  return {
    ...stat,
    type:
      typeBits === 0o120000
        ? 'symlink'
        : typeBits === 0o040000
          ? 'directory'
          : typeBits === 0o100000
            ? 'file'
            : 'other',
  };
};

/**
 * Parses one `OK <stat>` or `ERR` line per path.
 *
 * @param {Buffer} output
 * @param {number} count
 * @returns {Array<HostStat | null>}
 */
const parseStatLines = (output, count) => {
  const lines = output.toString('utf8').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  if (lines.length !== count) {
    throw new Error('Unexpected stat output.');
  }
  return lines.map((line) => {
    if (line === 'ERR') {
      return null;
    }
    if (!line.startsWith('OK ')) {
      throw new Error('Unexpected stat output.');
    }
    return parseStatLine(line.slice(3));
  });
};

/**
 * Parses one `OK <size>\n<exactly size bytes>` or `ERR\n` frame per path.
 *
 * @param {Buffer} output
 * @param {ReadonlyArray<string>} paths
 * @returns {Array<Buffer | Error>}
 */
const parseReadFilesOutput = (output, paths) => {
  /** @type {Array<Buffer | Error>} */
  const results = [];
  let offset = 0;
  for (const path of paths) {
    const newline = output.indexOf(10, offset);
    if (newline === -1) {
      throw new Error('Unexpected batch read output.');
    }
    const header = output.subarray(offset, newline).toString('utf8');
    offset = newline + 1;
    if (header === 'ERR') {
      results.push(new Error(`Cannot read ${path}.`));
      continue;
    }
    const match = /^OK (\d+)$/.exec(header);
    const size = match ? Number(match[1]) : -1;
    if (size < 0 || offset + size > output.length) {
      throw new Error('Unexpected batch read output.');
    }
    results.push(Buffer.from(output.subarray(offset, offset + size)));
    offset += size;
  }
  if (offset !== output.length) {
    throw new Error('Unexpected batch read output.');
  }
  return results;
};

/**
 * The bytes a path adds to a batch's remote command: quoted once for the
 * script and again by `wrapForLoginShell`, where a `'` grows to 13 bytes (POSIX)
 * and fish doubles every backslash. Plus one separating space.
 *
 * @param {string} path
 */
const getWrappedPathSize = (path) => {
  const quoted = quotePosix(path);
  return Math.max(Buffer.byteLength(quotePosix(quoted)), Buffer.byteLength(quoteFish(quoted))) - 1;
};

/**
 * Splits paths so that each batch's remote command, wrapped for any login
 * shell, stays below `MAX_BATCH_SCRIPT_BYTES`. A single longer path still gets
 * its own batch.
 *
 * @param {ReadonlyArray<string>} paths
 * @returns {Array<Array<string>>}
 */
const chunkByScriptSize = (paths) => {
  /** @type {Array<Array<string>>} */
  const chunks = [];
  /** @type {Array<string>} */
  let current = [];
  let size = 0;
  for (const path of paths) {
    const pathSize = getWrappedPathSize(path);
    if (current.length > 0 && size + pathSize > MAX_BATCH_PATH_BYTES) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(path);
    size += pathSize;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
};

/** @param {ReadonlyArray<string>} paths */
const setPositionalArgs = (paths) => `set -- ${paths.map(quotePosix).join(' ')}`;

/**
 * Prints `OK <stat>` or `ERR` per path, in order.
 *
 * @param {ReadonlyArray<string>} paths
 * @param {StatFlavor} statFlavor
 */
const buildLstatManyScript = (paths, statFlavor) => {
  const format = STAT_FORMATS[statFlavor];
  return [
    C_LOCALE,
    setPositionalArgs(paths),
    // One stat for the common case; per-path only when something is missing.
    `if out=$(stat ${format} "$@" 2>/dev/null); then printf '%s\\n' "$out" | sed 's/^/OK /'; else for p do if line=$(stat ${format} "$p" 2>/dev/null); then printf 'OK %s\\n' "$line"; else echo ERR; fi; done; fi`,
  ].join('\n');
};

/**
 * Prints `OK <size>` and exactly that many bytes, or `ERR`, per path, in order.
 *
 * @param {ReadonlyArray<string>} paths
 */
const buildReadFilesScript = (paths) =>
  [
    setPositionalArgs(paths),
    'for p do',
    '  if [ -f "$p" ] && [ -r "$p" ] && n=$(wc -c < "$p"); then',
    "    n=$(printf '%s' \"$n\" | tr -d ' ')",
    '    printf \'OK %s\\n\' "$n"',
    // Exactly n bytes even if the file changes while it is read: a file that
    // grows is cut off and one that shrinks is padded with zeros. BSD `head`
    // rejects `-c 0`, so empty files skip the copy.
    '    if [ "$n" -gt 0 ]; then cat "$p" /dev/zero 2>/dev/null | head -c "$n"; fi',
    '  else',
    '    echo ERR',
    '  fi',
    'done',
  ].join('\n');

const createAbortError = () => {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
};

/** @param {number} limit */
const createLimiter = (limit) => {
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];
  /** @param {AbortSignal | undefined} signal @returns {Promise<void>} */
  const acquire = (signal) => {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    // An aborted waiter leaves the queue at once instead of waiting for a slot.
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        waiting.splice(waiting.indexOf(start), 1);
        reject(createAbortError());
      };
      const start = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      waiting.push(start);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };
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
   * @param {AbortSignal} [signal]
   * @returns {Promise<T>}
   */
  return async (task, signal) => {
    await acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  };
};

// Login shell startup files can print to stderr (for example bash's setlocale
// warning) before the marker, so a bounded number of leading lines is scanned.
const PID_MARKER_SCAN_BYTES = 8 * 1024;

/**
 * Strips the `PID_MARKER<pid>` line (as printed by `buildCommandScript` with
 * `announcePid`) and any lines before it from a stream, and reports the PID.
 * Without a marker line in the first 8 KiB, the stream passes through as is.
 *
 * @param {(pid: number) => void} onPid
 */
const createPidMarkerFilter = (onPid) => {
  let pending = Buffer.alloc(0);
  let scanned = 0;
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
      let newline = pending.indexOf(10, scanned);
      while (newline !== -1 && newline < PID_MARKER_SCAN_BYTES) {
        const line = pending.subarray(scanned, newline).toString('utf8').replace(/\r$/, '');
        if (line.startsWith(PID_MARKER)) {
          done = true;
          const pid = Number(line.slice(PID_MARKER.length));
          if (Number.isSafeInteger(pid) && pid > 0) {
            onPid(pid);
          }
          const rest = pending.subarray(newline + 1);
          pending = Buffer.alloc(0);
          callback(null, rest.length > 0 ? rest : undefined);
          return;
        }
        scanned = newline + 1;
        newline = pending.indexOf(10, scanned);
      }
      if (pending.length >= PID_MARKER_SCAN_BYTES) {
        done = true;
        const buffered = pending;
        pending = Buffer.alloc(0);
        callback(null, buffered);
        return;
      }
      callback();
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
  const killLimit = createLimiter(1);
  const closing = new AbortController();
  /** @type {ConnectionState} */
  let state = 'connected';
  /** @type {Set<(state: ConnectionState) => void>} */
  const stateListeners = new Set();
  /** @param {ConnectionState} next */
  const setState = (next) => {
    if (state !== next) {
      state = next;
      for (const listener of stateListeners) {
        listener(next);
      }
    }
  };
  const assertOpen = () => {
    if (closed) {
      throw new Error(`SSH host ${alias} is closed.`);
    }
  };
  /** @type {Set<{kill: (signal?: NodeJS.Signals | number) => boolean; done: Promise<void>}>} */
  const processes = new Set();
  /** @type {Set<Promise<void>>} */
  const kills = new Set();

  // A queued client exposes streams immediately, preserving spawn's synchronous
  // API and stream backpressure. Its slot belongs to the real child until close,
  // even if an exec caller has already rejected on cancellation.
  /** @param {string} command @param {{tty?: boolean}} [options] @returns {QueuedChild} */
  const queueClient = (command, options) => {
    assertOpen();
    const controller = new AbortController();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
    let child = null;
    let cancelled = false;
    let finished = false;
    const cancelQueued = () => {
      if (child || finished) {
        return false;
      }
      cancelled = true;
      controller.abort();
      return true;
    };
    const cancelOnClose = () => {
      cancelQueued();
    };
    closing.signal.addEventListener('abort', cancelOnClose, { once: true });
    const facade = /** @type {QueuedChild} */ (
      /** @type {unknown} */ (
        Object.assign(new EventEmitter(), {
          cancelQueued,
          stdin,
          stdout,
          stderr,
          kill: (/** @type {NodeJS.Signals | number | undefined} */ signal) => {
            if (cancelQueued()) {
              return true;
            }
            return child?.kill(signal) ?? false;
          },
        })
      )
    );
    void limit(async () => {
      if (cancelled || closed) {
        throw createAbortError();
      }
      keepMasterAlive();
      child = connection.spawnClient(command, options);
      stdin.pipe(child.stdin);
      child.stdout.pipe(stdout);
      child.stderr.pipe(stderr);
      stdin.on('error', () => {});
      child.stdin.on('error', () => {});
      await new Promise((resolve) => {
        child?.on('error', (error) => facade.emit('error', error));
        child?.on('close', (code, signal) => {
          finished = true;
          facade.emit('close', code, signal);
          resolve(undefined);
        });
      });
    }, controller.signal)
      .catch((error) => {
        if (!cancelled && !closed) {
          facade.emit('error', error);
        }
        stdout.end();
        stderr.end();
        facade.emit('close', null, 'SIGTERM');
      })
      .finally(() => {
        finished = true;
        closing.signal.removeEventListener('abort', cancelOnClose);
      });
    return facade;
  };
  let lastMasterCheck = 0;
  let closed = false;
  /** @type {Promise<void> | null} */
  let restoringMaster = null;
  /** @type {Set<NodeJS.Timeout>} */
  const killTimers = new Set();

  // Clients never connect on their own, so a lost master fails operations until
  // this restores it in the background. `close` waits for it, so a restore
  // cannot leave a master running after the host is closed.
  const ensureMaster = () => {
    assertOpen();
    if (restoringMaster) {
      return restoringMaster;
    }
    restoringMaster = Promise.resolve()
      .then(() => connection.ensureMaster())
      .then(() => {
        if (!closed) {
          setState('connected');
        }
      })
      .catch((error) => {
        if (!closed) {
          setState('disconnected');
        }
        throw error;
      })
      .finally(() => {
        restoringMaster = null;
      });
    return restoringMaster;
  };
  const restoreMaster = () => {
    if (!closed) {
      void ensureMaster().catch(() => {});
    }
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
  /** @param {number} pid @param {NodeJS.Signals | number} signal */
  const killRemote = (pid, signal) => {
    const signalNumber = typeof signal === 'number' ? signal : signal.slice(3);
    const pending = killLimit(
      () =>
        new Promise((resolve) => {
          const child = connection.spawnClient(
            toRemoteCommand(`kill -${signalNumber} ${Math.trunc(pid)} 2>/dev/null; :`),
          );
          child.on('error', () => {});
          child.on('close', () => resolve(undefined));
          child.stdout.resume();
          child.stderr.resume();
          child.stdin.end();
        }),
    ).finally(() => kills.delete(pending));
    kills.add(pending);
  };

  /**
   * Stops one command: its local ssh client and, by its announced PID, the
   * remote process. Stopping is idempotent and is skipped once the local client
   * has closed, since the PID may belong to another process by then. A small
   * window remains between the remote exit and the local 'close' in which a
   * kill can still target a PID that was just freed.
   *
   * Killing the client while the master is still setting up the session leaves
   * that session running and holding the client's pipes until the remote
   * process exits, with no PID to kill it by. Until the PID is announced, the
   * client is therefore only killed once it arrives (or after a timeout).
   *
   * @param {QueuedChild} child
   */
  const createRemoteProcess = (child) => {
    /** @type {number | null} */
    let pid = null;
    let killed = false;
    let exited = false;
    /** @type {NodeJS.Signals | number} */
    let killSignal = 'SIGTERM';
    /** @type {() => void} */
    let finish;
    const done = new Promise((resolve) => {
      finish = () => resolve(undefined);
    });
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        killTimers.delete(timer);
        timer = undefined;
      }
    };
    const killNow = () => {
      clearTimer();
      if (pid != null) {
        killRemote(pid, killSignal);
      }
      child.kill(killSignal);
    };
    const remote = {
      done,
      /** @param {number} value */
      announce: (value) => {
        pid = value;
        if (killed && !exited) {
          killNow();
        }
      },
      exit: () => {
        exited = true;
        clearTimer();
        processes.delete(remote);
        finish();
      },
      /** @param {NodeJS.Signals | number} [signal] */
      kill: (signal = 'SIGTERM') => {
        if (killed || exited) {
          return false;
        }
        if (
          (typeof signal === 'string' && !Object.hasOwn(constants.signals, signal)) ||
          (typeof signal === 'number' && (!Number.isInteger(signal) || signal < 0 || signal > 64))
        ) {
          throw new Error(`Invalid signal: ${signal}`);
        }
        if (signal === 0) {
          if (pid == null) {
            return false;
          }
          killRemote(pid, 0);
          return true;
        }
        killed = true;
        killSignal = signal;
        if (child.cancelQueued()) {
          return true;
        }
        if (pid != null) {
          killNow();
        } else {
          timer = setTimeout(killNow, PID_WAIT_MS);
          timer.unref();
          killTimers.add(timer);
        }
        return true;
      },
    };
    processes.add(remote);
    return remote;
  };

  /**
   * Exit 255 is either an ssh failure or a command that exited 255. Only a
   * dead master makes it an ssh failure.
   *
   * @param {SshResult} result
   * @returns {Promise<Error | null>}
   */
  const getConnectionError = async (result) => {
    if (closed || result.code !== 255 || (await connection.check())) {
      return null;
    }
    if (!closed) {
      setState('disconnected');
      restoreMaster();
    }
    return new HostDisconnectedError(alias, result.stderr);
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
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }
      const child = queueClient(toRemoteCommand(script));
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
    });

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
    const child = queueClient(
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
    let killed = false;
    const hostProcess = Object.assign(new EventEmitter(), {
      kill: (/** @type {NodeJS.Signals | number | undefined} */ signal) => {
        const result = remote.kill(signal);
        killed ||= result;
        return result;
      },
      stderr,
      stdin: child.stdin,
      stdout: child.stdout,
    });
    Object.defineProperty(hostProcess, 'killed', { get: () => killed });
    let diagnostics = '';
    stderr.on(
      'data',
      (chunk) => (diagnostics = (diagnostics + chunk.toString()).slice(-64 * 1024)),
    );
    // Emit 'close' only after the filtered stderr has received everything.
    const emitClose = () => {
      if (exitCode !== undefined && stderrFinished) {
        const code = exitCode;
        void getConnectionError({
          code,
          stderr: diagnostics,
          stdout: Buffer.alloc(0),
        })
          .then((error) => {
            if (error) {
              hostProcess.emit('error', error);
            }
            hostProcess.emit('close', code, exitSignal);
          })
          .catch((error) => {
            hostProcess.emit('error', error);
            hostProcess.emit('close', code, exitSignal);
          });
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
    assertOpen();
    const script = `stty cols ${Math.trunc(options.cols)} rows ${Math.trunc(options.rows)} 2>/dev/null; ${buildCommandScript(
      {
        announcePid: true,
        args,
        command,
        cwd: options.cwd,
        env: { ...options.env, TERM: options.name },
      },
    )}`;
    const child = queueClient(toRemoteCommand(script), { tty: true });
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
    let diagnostics = '';
    child.stderr.on(
      'data',
      (chunk) => (diagnostics = (diagnostics + chunk.toString()).slice(-64 * 1024)),
    );
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      remote.exit();
      void getConnectionError({
        code,
        stderr: diagnostics,
        stdout: Buffer.alloc(0),
      }).finally(() => {
        exitCode = code;
        emitExit();
      });
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

  /** @param {string} path */
  const assertAbsolute = (path) => {
    if (!path.startsWith('/')) {
      throw new Error(`SSH host paths must be absolute: ${path}`);
    }
    return path;
  };

  /**
   * Runs a file operation's script and returns its stdout.
   *
   * @param {string} operation
   * @param {string} subject
   * @param {string} script
   * @param {{input?: string | Buffer}} [options]
   */
  const run = async (operation, subject, script, options = {}) => {
    const result = await runScript(script, { input: options.input, label: operation });
    if (result.code === 0) {
      return result.stdout;
    }
    const connectionError = await getConnectionError(result);
    if (connectionError) {
      throw connectionError;
    }
    throw new Error(
      `${operation} ${subject}: ${result.stderr.trim() || `exited with status ${result.code}`}`,
    );
  };

  /** @param {string} path @param {boolean} follow */
  const statPath = async (path, follow) =>
    parseStatLine(
      (
        await run(
          follow ? 'stat' : 'lstat',
          path,
          `${C_LOCALE}\nexec stat ${follow ? '-L ' : ''}${STAT_FORMATS[statFlavor]} ${quotePosix(assertAbsolute(path))}`,
        )
      ).toString('utf8'),
    );

  /** @type {RepositoryHost['lstatMany']} */
  const lstatMany = async (paths) => {
    assertOpen();
    /** @type {Array<HostStat | null>} */
    const results = [];
    for (const chunk of chunkByScriptSize(paths.map(assertAbsolute))) {
      const output = await run(
        'lstat',
        `${chunk.length} paths`,
        buildLstatManyScript(chunk, statFlavor),
      );
      results.push(...parseStatLines(output, chunk.length));
    }
    return results;
  };

  /** @type {RepositoryHost['readFiles']} */
  const readFiles = async (paths) => {
    assertOpen();
    /** @type {Array<Buffer | Error>} */
    const results = [];
    for (const chunk of chunkByScriptSize(paths.map(assertAbsolute))) {
      const output = await run('readFile', `${chunk.length} paths`, buildReadFilesScript(chunk));
      results.push(...parseReadFilesOutput(output, chunk));
    }
    return results;
  };

  /** @param {Buffer} output */
  const withoutTrailingNewline = (output) => output.toString('utf8').replace(/\n$/, '');

  /** @type {RepositoryHost['writeFile']} */
  const writeFile = async (path, contents, options = {}) => {
    const target = quotePosix(assertAbsolute(path));
    const mode = options.mode == null ? null : (options.mode & 0o7777).toString(8);
    const chmod = mode ? `chmod ${mode} ${target} && ` : '';
    // The file is opened (as fd 3) before `chmod`, so a read-only mode still
    // lets the contents be written through it. Under `set -C` (noclobber) the
    // open fails if the file exists. Without `exclusive`, only a file this call
    // creates gets the mode.
    const script = options.exclusive
      ? `set -C; exec 3> ${target} && ${chmod}exec cat >&3`
      : mode
        ? `if [ -e ${target} ]; then exec 3> ${target}; else exec 3> ${target} && chmod ${mode} ${target}; fi && exec cat >&3`
        : `exec cat > ${target}`;
    await run('writeFile', path, script, { input: contents });
  };

  /** @type {RepositoryHost['mkdtemp']} */
  const mkdtemp = async (prefix) => {
    if (!/^[\w.-]+$/.test(prefix)) {
      throw new Error(`Invalid temporary directory prefix: ${prefix}`);
    }
    return withoutTrailingNewline(
      await run(
        'mkdtemp',
        prefix,
        `dir=\${TMPDIR:-/tmp}; exec mktemp -d "\${dir%/}/${prefix}XXXXXX"`,
      ),
    );
  };

  /** @type {Promise<void> | null} */
  let closePromise = null;
  return Object.freeze({
    close: () => {
      closePromise ??= (async () => {
        closed = true;
        setState('closed');
        closing.abort();
        const active = [...processes];
        for (const remote of active) {
          remote.kill('SIGKILL');
        }
        await Promise.all(active.map((remote) => remote.done));
        await Promise.all(kills);
        await restoringMaster?.catch(() => {});
        await connection.exitMaster();
      })();
      return closePromise;
    },
    getConnectionState: () => state,
    onConnectionState: (/** @type {(state: ConnectionState) => void} */ listener) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    reconnect: async () => {
      assertOpen();
      await ensureMaster();
      assertOpen();
    },
    exec,
    id: getSshHostId(alias, connection.port),
    label: alias,
    lstat: (path) => statPath(path, false),
    lstatMany,
    mkdtemp,
    readFile: async (path) => run('readFile', path, `exec cat ${quotePosix(assertAbsolute(path))}`),
    readFiles,
    readlink: async (path) =>
      withoutTrailingNewline(
        await run('readlink', path, `exec readlink ${quotePosix(assertAbsolute(path))}`),
      ),
    realpath: async (path) =>
      withoutTrailingNewline(
        await run('realpath', path, `exec realpath ${quotePosix(assertAbsolute(path))}`),
      ),
    rename: async (from, to) => {
      // `mv` would move the file into an existing directory instead of failing.
      await run(
        'rename',
        from,
        [
          setPositionalArgs([assertAbsolute(from), assertAbsolute(to)]),
          'if [ -d "$2" ]; then echo "rename: $2: Is a directory" >&2; exit 1; fi',
          'exec mv -f "$1" "$2"',
        ].join('\n'),
      );
    },
    rm: async (path, options = {}) => {
      const flags = `${options.recursive ? 'r' : ''}${options.force ? 'f' : ''}`;
      await run(
        'rm',
        path,
        `exec rm ${flags ? `-${flags} ` : ''}${quotePosix(assertAbsolute(path))}`,
      );
    },
    spawn,
    spawnPty,
    stat: (path) => statPath(path, true),
    writeFile,
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
  // A master this call starts must not outlive a failed connect.
  const adoptedMaster = await connection.check();
  await connection.ensureMaster();
  try {
    // The login shell parses this one fixed command; it is valid in every shell.
    const shellResult = await connection.run(`printf '${SHELL_PROBE_PREFIX}%s\\n' "$SHELL"`);
    if (shellResult.code !== 0) {
      throw classifySshFailure(alias, shellResult.stderr, { connected: false });
    }
    // Anything but exactly this one line, blank lines included, would also
    // reach the output of every command.
    const shellOutput = shellResult.stdout.toString('utf8');
    const shell = shellOutput.slice(SHELL_PROBE_PREFIX.length, -1);
    if (shellOutput !== `${SHELL_PROBE_PREFIX}${shell}\n` || shell.includes('\n')) {
      throw new RemoteShellNoiseError(alias);
    }
    const dialect = getShellDialect(shell);
    if (!dialect) {
      throw new UnsupportedRemoteShellError(alias, shell);
    }

    const probe = await connection.run(
      wrapForLoginShell(
        `if stat -c '%f %s %i %.9Y %.9Z' / >/dev/null 2>&1 && stat --version 2>/dev/null | grep -q 'GNU'; then echo gnu; elif stat -f '%Xp %z %i %Fm %Fc' / >/dev/null 2>&1; then echo bsd; else echo unsupported; fi; for c in git realpath; do command -v "$c" >/dev/null 2>&1 || echo "missing:$c"; done`,
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
    if (probeLines[0] !== 'gnu' && probeLines[0] !== 'bsd') {
      throw new Error(`Codiff needs GNU or BSD stat on ${alias}.`);
    }
    return createSshHost({
      alias,
      connection,
      dialect,
      masterCheckIntervalMs,
      statFlavor: probeLines[0] === 'gnu' ? 'gnu' : 'bsd',
    });
  } catch (error) {
    if (!adoptedMaster) {
      await connection.exitMaster().catch(() => {});
    }
    throw error;
  }
};

module.exports = {
  buildLstatManyScript,
  buildReadFilesScript,
  chunkByScriptSize,
  connectSshHost,
  createPidMarkerFilter,
  createSshHost,
  parseReadFilesOutput,
  parseStatLine,
  parseStatLines,
};
