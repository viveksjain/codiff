// @ts-check

/**
 * Runs window launches one at a time, so each launch sees the windows that
 * earlier launches created. A launch that hangs (for example on an unreachable
 * repository host) stops blocking later launches after `timeoutMs`; it keeps
 * running in the background.
 *
 * @param {{
 *   clearTimeoutImpl?: (timer: any) => void;
 *   setTimeoutImpl?: (callback: () => void, delay: number) => any;
 *   timeoutMs?: number;
 * }} [options]
 */
const createWindowLaunchQueue = ({
  clearTimeoutImpl = clearTimeout,
  setTimeoutImpl = setTimeout,
  timeoutMs = 60_000,
} = {}) => {
  /** @type {Promise<void>} */
  let tail = Promise.resolve();
  let pending = 0;
  return {
    hasPending: () => pending > 0,
    /**
     * @template T
     * @param {() => Promise<T>} launch
     * @returns {Promise<T>}
     */
    enqueue: (launch) => {
      pending += 1;
      const result = tail.then(launch).finally(() => {
        pending -= 1;
      });
      tail = tail.then(
        () =>
          new Promise((resolve) => {
            const timer = setTimeoutImpl(resolve, timeoutMs);
            timer?.unref?.();
            const release = () => {
              clearTimeoutImpl(timer);
              resolve(undefined);
            };
            result.then(release, release);
          }),
      );
      return result;
    },
  };
};

module.exports = { createWindowLaunchQueue };
