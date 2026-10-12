// @ts-check
const { join, posix } = require('node:path');
const MAX_SESSION_READ_BYTES = 16 * 1024 * 1024;
/** @typedef {import('./host/repository-host.cjs').RepositoryHost} RepositoryHost */
/** @param {RepositoryHost} host */
const hostPath = (host) => (host.id === 'local' ? { join } : posix);
/** @param {RepositoryHost} host @param {string} override @param {string} defaultDirectory */
const getSessionHome = async (host, override, defaultDirectory) => {
  const environment = await host.getEnvironment();
  // Like os.homedir(), Windows prefers USERPROFILE over HOME (set by MSYS and Git Bash).
  const home =
    host.id === 'local' && process.platform === 'win32'
      ? environment.USERPROFILE || environment.HOME
      : environment.HOME || environment.USERPROFILE;
  if (environment[override]) return environment[override];
  if (!home) throw new Error(`HOME is unavailable on ${host.label || 'this machine'}.`);
  return hostPath(host).join(home, defaultDirectory);
};
/** @param {RepositoryHost} host @param {string} path */
const readSessionFileTail = async (host, path) => {
  try {
    const stat = await host.stat(path);
    if (stat.type !== 'file' || !stat.size) return '';
    const truncated = stat.size > MAX_SESSION_READ_BYTES;
    const buffer = await host.readFileTail(path, MAX_SESSION_READ_BYTES + (truncated ? 1 : 0));
    if (!truncated) return buffer.toString('utf8');
    const newline = buffer.indexOf(10);
    return newline < 0 ? '' : buffer.subarray(newline + 1).toString('utf8');
  } catch (error) {
    if (error instanceof Error && error.name.startsWith('Host')) throw error;
    return '';
  }
};
module.exports = { readSessionFileTail, getSessionHome, hostPath };
