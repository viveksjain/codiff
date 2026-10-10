// @ts-check

/**
 * @typedef {import('./host/repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {{host: RepositoryHost; repositoryPath: string}} WindowRepository
 */

/**
 * Tracks which repository, on which host, each window shows. Windows that have
 * not stored one yet use the local host and the current launch path.
 *
 * @param {{getLaunchPath: () => string; localHost: RepositoryHost}} options
 */
const createWindowRepositories = ({ getLaunchPath, localHost }) => {
  /** @type {Map<number, WindowRepository>} */
  const repositories = new Map();
  return {
    /** @param {number} id */
    delete: (id) => {
      repositories.delete(id);
    },
    /** @param {number} id @returns {WindowRepository} */
    get: (id) => repositories.get(id) ?? { host: localHost, repositoryPath: getLaunchPath() },
    /** @param {number} id @param {WindowRepository} repository */
    set: (id, repository) => {
      repositories.set(id, repository);
    },
  };
};

module.exports = { createWindowRepositories };
