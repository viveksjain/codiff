// @ts-check
const { existsSync } = require('node:fs');
const { posix } = require('node:path');

/** @typedef {import('./repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {{alias: string; port?: number; path: string; hostId: string}} RemoteRepositoryTarget
 */

/** @param {string} alias @param {number} [port] */
const getSshHostId = (alias, port) => {
  const at = alias.lastIndexOf('@');
  const host = alias.slice(at + 1);
  const destination = host.includes(':') ? `${alias.slice(0, at + 1)}[${host}]` : alias;
  return `ssh://${destination}${port !== undefined ? `:${port}` : ''}`;
};

/** @param {RemoteRepositoryTarget} target */
const formatRemoteRepositoryTarget = (target) => {
  const at = target.alias.lastIndexOf('@');
  const host = target.alias.slice(at + 1);
  const destination = `${at >= 0 ? `${encodeURIComponent(target.alias.slice(0, at))}@` : ''}${host.includes(':') ? `[${host}]` : host}`;
  const path = target.path.split('/').map(encodeURIComponent).join('/');
  return `ssh://${destination}${target.port !== undefined ? `:${target.port}` : ''}${path.startsWith('/') ? '' : '/'}${path}`;
};

/** @param {string} value @param {{exists?: (path: string) => boolean}} [options]
 * @returns {RemoteRepositoryTarget | null} */
const parseRepositoryTarget = (value, { exists = existsSync } = {}) => {
  if (!value.startsWith('ssh://') && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return null;
  }
  let alias;
  let path;
  let port;
  if (value.startsWith('ssh://')) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid SSH repository: ${value}`);
    }
    if (
      url.password ||
      url.search ||
      url.hash ||
      !url.hostname ||
      !url.pathname ||
      url.pathname === '/'
    ) {
      throw new Error('Use ssh://[user@]host[:port]/absolute/repository/path.');
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    alias = `${url.username ? `${decodeURIComponent(url.username)}@` : ''}${hostname}`;
    port = url.port ? Number(url.port) : undefined;
    path = decodeURIComponent(url.pathname);
    if (path === '/~' || path.startsWith('/~/')) {
      path = path.slice(1);
    }
  } else {
    const colon = value.indexOf(':');
    if (colon < 0 || value.slice(0, colon).includes('/') || exists(value)) {
      return null;
    }
    alias = value.slice(0, colon);
    path = value.slice(colon + 1);
  }
  if (
    !(
      /^(?!-)(?!.*@-)[\w.@%+-]+$/.test(alias) ||
      /^(?:[\w.%+-]+@)?[a-fA-F0-9]*:[a-fA-F0-9:]+$/.test(alias)
    )
  ) {
    throw new Error(`Invalid SSH host: ${alias}`);
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`Invalid SSH port: ${port}`);
  }
  if ((!path.startsWith('/') && path !== '~' && !path.startsWith('~/')) || path.includes('\0')) {
    throw new Error('Remote repository paths must be absolute or start with ~/.');
  }
  return {
    alias,
    ...(port !== undefined ? { port } : {}),
    path,
    hostId: getSshHostId(alias, port),
  };
};

/** @param {RepositoryHost} host @param {string} path @returns {Promise<string>} */
const resolveRemoteRepository = async (host, path) => {
  if (path === '~' || path.startsWith('~/')) {
    const home = (await host.exec('sh', ['-c', 'printf %s "$HOME"'])).toString('utf8');
    if (!home.startsWith('/') || home.includes('\0')) {
      throw new Error(`Invalid HOME on ${host.label}.`);
    }
    path = posix.join(home, path === '~' ? '' : path.slice(2));
  }
  if (!path.startsWith('/') || path.includes('\0')) {
    throw new Error('Remote repository paths must be absolute or start with ~/.');
  }
  const root = (await host.exec('git', ['rev-parse', '--show-toplevel'], { cwd: path }))
    .toString('utf8')
    .replace(/\r?\n$/, '');
  if (!root.startsWith('/')) {
    throw new Error(`Invalid Git repository root on ${host.label}.`);
  }
  return host.realpath(root);
};

/** @param {RepositoryHost} host @param {string} repositoryPath
 * @param {{candidate?: string; range?: {base: string; head: string; symmetric: boolean}}} options
 * @returns {Promise<import('../../core/types.ts').ReviewSource | undefined>} */
const resolveRemoteSource = async (host, repositoryPath, { candidate, range }) => {
  /** @param {ReadonlyArray<string>} args */
  const succeeds = async (args) => {
    try {
      await host.exec('git', args, { cwd: repositoryPath });
      return true;
    } catch (error) {
      if (error instanceof Error && error.name.startsWith('Host')) {
        throw error;
      }
      return false;
    }
  };
  /** @param {string} ref */
  const commit = (ref) =>
    succeeds(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  if (range) {
    for (const ref of [range.base, range.head]) {
      if (!(await commit(ref))) {
        throw new Error(`Unknown remote revision: ${ref}`);
      }
    }
    return { ...range, type: 'range' };
  }
  if (!candidate) {
    return undefined;
  }
  const revision = /^(?:[0-9a-f]{4,64}|HEAD|@)(?:$|[~^@])|[~^]|@\{/i.test(candidate);
  if (revision && (await commit(candidate))) {
    return { ref: candidate, type: 'commit' };
  }
  if (
    (await succeeds(['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`])) ||
    (await succeeds(['show-ref', '--verify', '--quiet', `refs/remotes/${candidate}`]))
  ) {
    return { ref: candidate, type: 'branch-working-tree' };
  }
  if (await commit(candidate)) {
    return { ref: candidate, type: 'commit' };
  }
  throw new Error(`Unknown remote revision: ${candidate}`);
};
module.exports = {
  formatRemoteRepositoryTarget,
  getSshHostId,
  parseRepositoryTarget,
  resolveRemoteRepository,
  resolveRemoteSource,
};
