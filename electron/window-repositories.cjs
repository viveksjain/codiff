// @ts-check

/**
 * @typedef {import('./host/repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {{host: RepositoryHost; repositoryPath: string}} WindowRepository
 */

/** Stores explicit window context. Missing context must never execute locally. */
const createWindowRepositories = () => {
  /** @type {Map<number, WindowRepository>} */
  const repositories = new Map();
  return {
    /** @param {number} id */
    delete: (id) => {
      repositories.delete(id);
    },
    /** @param {number} id @returns {WindowRepository} */
    get: (id) => {
      const repository = repositories.get(id);
      if (!repository) {
        throw new Error(`Missing repository context for window ${id}.`);
      }
      return repository;
    },
    /** @param {number} id @param {WindowRepository} repository */
    set: (id, repository) => {
      repositories.set(id, repository);
    },
  };
};

module.exports = { createWindowRepositories };
