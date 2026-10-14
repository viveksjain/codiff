// @ts-check

/** @typedef {import('../../core/types.ts').RepositoryState} RepositoryState */

/**
 * Retain the tracked snapshot while the initial read runs before the renderer
 * connects. Each subscriber belongs to one IPC request and can detach safely.
 * @param {(report: (state: RepositoryState) => void) => Promise<RepositoryState>} read
 */
const createRepositoryStateLoad = (read) => {
  /** @type {RepositoryState | undefined} */
  let trackedState;
  let settled = false;
  /** @type {Set<(state: RepositoryState) => void>} */
  const listeners = new Set();
  const promise = read((state) => {
    if (settled) {
      return;
    }
    trackedState = state;
    for (const listener of listeners) {
      listener(state);
    }
  }).finally(() => {
    settled = true;
    trackedState = undefined;
    listeners.clear();
  });
  // Prefetch starts before an IPC caller can attach a rejection handler.
  promise.catch(() => {});
  return {
    promise,
    /** @param {(state: RepositoryState) => void} listener */
    subscribe: (listener) => {
      if (!settled) {
        listeners.add(listener);
        if (trackedState) {
          listener(trackedState);
        }
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

module.exports = { createRepositoryStateLoad };
