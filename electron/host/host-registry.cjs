// @ts-check
const { connectSshHost } = require('./ssh-host.cjs');
const { getCommandEnvironment } = require('../login-shell-environment.cjs');
/** @typedef {import('./repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {import('./ssh-host.cjs').SshHost} SshHost
 * @typedef {import('./repository-target.cjs').RemoteRepositoryTarget} RemoteRepositoryTarget
 * @typedef {{refs: number; host: Promise<SshHost>; closing: Promise<void> | null}} Entry
 */
/** @param {{localHost: RepositoryHost; connect?: typeof connectSshHost; getLocalEnvironment?: () => Promise<NodeJS.ProcessEnv>}} options */
const createHostRegistry = ({
  localHost,
  connect = connectSshHost,
  getLocalEnvironment = getCommandEnvironment,
}) => {
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  let closed = false;
  /** @type {Promise<void> | null} */
  let closing = null;
  /** @param {string} key @param {Entry} entry */
  const closeEntry = (key, entry) => {
    entry.closing ??= entry.host
      .then(
        (host) => host.close(),
        () => {},
      )
      .finally(() => {
        if (entries.get(key) === entry) {
          entries.delete(key);
        }
      });
    return entry.closing;
  };
  /** @param {RemoteRepositoryTarget | null} target
   * @returns {Promise<{host: RepositoryHost; release: () => Promise<void>}>} */
  const acquire = async (target) => {
    if (closed) {
      throw new Error('Host registry is closed.');
    }
    if (!target) {
      return { host: localHost, release: async () => {} };
    }
    if (process.platform === 'win32') {
      throw new Error('Remote repositories require macOS or Linux.');
    }
    const key = target.hostId;
    let entry = entries.get(key);
    if (entry?.closing) {
      await entry.closing;
      return acquire(target);
    }
    if (!entry) {
      entry = {
        refs: 0,
        closing: null,
        host: Promise.resolve().then(() =>
          connect({ alias: target.alias, port: target.port, getLocalEnvironment }),
        ),
      };
      entries.set(key, entry);
    }
    entry.refs++;
    let released = false;
    const release = async () => {
      if (released) {
        return;
      }
      released = true;
      entry.refs--;
      if (entry.refs === 0 || closed) {
        await closeEntry(key, entry);
      }
    };
    try {
      const host = await entry.host;
      // A shared host may have lost its master since another window opened it.
      if (!closed && host.getConnectionState?.() === 'disconnected') {
        await host.reconnect();
      }
      if (closed) {
        await release();
        throw new Error('Host registry is closed.');
      }
      return { host, release };
    } catch (error) {
      await release();
      throw error;
    }
  };
  return {
    acquire,
    close: () => {
      closed = true;
      closing ??= Promise.all([...entries].map(([key, entry]) => closeEntry(key, entry))).then(
        () => {},
      );
      return closing;
    },
  };
};
module.exports = { createHostRegistry };
