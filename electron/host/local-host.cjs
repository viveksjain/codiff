// @ts-check

const { execFile, spawn } = require('node:child_process');
const { promises: fs, realpath: realpathCallback } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');
const { spawnPty } = require('../pty.cjs');
const { getCommandEnvironment } = require('../login-shell-environment.cjs');

/**
 * @typedef {import('./repository-host.cjs').HostStat} HostStat
 * @typedef {import('./repository-host.cjs').RepositoryHost} RepositoryHost
 */

// Node's JS realpath (not the native realpath(3) behind fs.promises.realpath),
// matching the pre-host window identity code on Windows and macOS.
const realpath = promisify(realpathCallback);

const DEFAULT_MAX_BUFFER = 1024 * 1024 * 64;

/** @param {import('node:fs').Stats} stats @returns {HostStat} */
const toHostStat = (stats) => ({
  ctimeMs: stats.ctimeMs,
  ino: stats.ino,
  mode: stats.mode,
  mtimeMs: stats.mtimeMs,
  size: stats.size,
  type: stats.isSymbolicLink()
    ? 'symlink'
    : stats.isDirectory()
      ? 'directory'
      : stats.isFile()
        ? 'file'
        : 'other',
});

/** @param {unknown} error */
const toError = (error) => (error instanceof Error ? error : new Error(String(error)));

/** @param {Readonly<Record<string, string>> | undefined} env @returns {NodeJS.ProcessEnv} */
const mergeEnvironment = (env) => (env ? { ...process.env, ...env } : process.env);

/** @type {RepositoryHost['exec']} */
const exec = (command, args, options = {}) => {
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const env = mergeEnvironment(options.env);
  if (options.input === undefined) {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        { cwd: options.cwd, encoding: 'buffer', env, maxBuffer, signal: options.signal },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  }

  const input = options.input;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** @type {Array<Buffer>} */
    const stdout = [];
    /** @type {Array<Buffer>} */
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;

    /** @param {Error} error */
    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        child.kill();
        fail(new Error(`${command} output exceeded ${maxBuffer} bytes.`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', (error) => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EPIPE') {
        fail(error);
      }
    });
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(
          new Error(
            Buffer.concat(stderr).toString('utf8') || `${command} exited with status ${code}`,
          ),
        );
      }
    });

    child.stdin.end(input);
  });
};

/** @type {RepositoryHost['writeFile']} */
const writeFile = async (path, contents, options = {}) => {
  if (!options.exclusive) {
    await fs.writeFile(path, contents, options.mode == null ? undefined : { mode: options.mode });
    return;
  }
  const file = await fs.open(path, 'wx', options.mode);
  try {
    if (options.mode != null) {
      await file.chmod(options.mode);
    }
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
};

const getEnvironment = async () => {
  /** @type {Record<string, string>} */
  const environment = {};
  for (const [key, value] of Object.entries(await getCommandEnvironment())) {
    if (typeof value === 'string') environment[key] = value;
  }
  return environment;
};
/** @returns {RepositoryHost} */
const createLocalHost = () =>
  Object.freeze({
    exec,
    getEnvironment,
    id: 'local',
    label: '',
    lstat: async (path) => toHostStat(await fs.lstat(path)),
    lstatMany: (paths) =>
      Promise.all(paths.map((path) => fs.lstat(path).then(toHostStat, () => null))),
    mkdtemp: (prefix) => fs.mkdtemp(join(tmpdir(), prefix)),
    readFile: (path) => fs.readFile(path),
    readFileTail: async (path, maxBytes) => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid tail size.');
      const file = await fs.open(path, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error('Expected a regular file.');
        const size = Math.min(maxBytes, stat.size);
        const buffer = Buffer.alloc(size);
        let read = 0;
        while (read < size) {
          const result = await file.read(buffer, read, size - read, stat.size - size + read);
          if (!result.bytesRead) break;
          read += result.bytesRead;
        }
        return buffer.subarray(0, read);
      } finally {
        await file.close();
      }
    },
    readdir: async (path) =>
      (await fs.readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        type: entry.isSymbolicLink()
          ? 'symlink'
          : entry.isFile()
            ? 'file'
            : entry.isDirectory()
              ? 'directory'
              : 'other',
      })),
    resolveCommand: async (name) => {
      if (!name || name.startsWith('-') || name.includes('\0'))
        throw new Error('Invalid command name.');
      const environment = await getEnvironment();
      if (process.platform === 'win32') {
        try {
          return (
            (await exec('where.exe', [name], { env: environment })).toString().split(/\r?\n/)[0] ||
            null
          );
        } catch {
          return null;
        }
      }
      try {
        return (
          (await exec('/bin/sh', ['-c', 'command -v "$1"', 'sh', name], { env: environment }))
            .toString()
            .trim() || null
        );
      } catch {
        return null;
      }
    },
    readFiles: (paths) => Promise.all(paths.map((path) => fs.readFile(path).catch(toError))),
    readlink: (path) => fs.readlink(path),
    realpath: (path) => realpath(path),
    rename: (from, to) => fs.rename(from, to),
    rm: (path, options = {}) => fs.rm(path, options),
    spawn: (command, args, options = {}) =>
      spawn(command, [...args], {
        cwd: options.cwd,
        env: mergeEnvironment(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    spawnPty: (command, args, options) =>
      spawnPty(command, [...args], { ...options, env: mergeEnvironment(options.env) }),
    stat: async (path) => toHostStat(await fs.stat(path)),
    writeFile,
  });

module.exports = { createLocalHost };
