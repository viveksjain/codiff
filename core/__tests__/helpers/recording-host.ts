import type { RepositoryHost } from '../../../electron/host/repository-host.cjs';

export type HostCall = { args: ReadonlyArray<unknown>; method: string };

export const createRecordingHost = (inner: RepositoryHost) => {
  const calls: Array<HostCall> = [];
  const host = Object.fromEntries(
    Object.entries(inner).map(([method, value]) => [
      method,
      typeof value === 'function'
        ? (...args: Array<unknown>) => {
            calls.push({ args, method });
            return (value as (...values: Array<unknown>) => unknown)(...args);
          }
        : value,
    ]),
  ) as RepositoryHost;
  return { calls, host };
};
