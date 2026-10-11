import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createWindowLaunchQueue } = require('../main/window-launch-queue.cjs') as {
  createWindowLaunchQueue: (options?: {
    clearTimeoutImpl?: (timer: unknown) => void;
    setTimeoutImpl?: (callback: () => void, delay: number) => unknown;
    timeoutMs?: number;
  }) => { hasPending: () => boolean; enqueue: <T>(launch: () => Promise<T>) => Promise<T> };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('runs launches one at a time in order', async () => {
  const queue = createWindowLaunchQueue();
  const first = deferred<string>();
  const order: Array<string> = [];
  const a = queue.enqueue(async () => {
    order.push('a:start');
    const value = await first.promise;
    order.push('a:end');
    return value;
  });
  const b = queue.enqueue(async () => {
    order.push('b:start');
    return 'b';
  });
  await flush();
  expect(order).toEqual(['a:start']);
  first.resolve('a');
  expect(await a).toBe('a');
  expect(await b).toBe('b');
  expect(order).toEqual(['a:start', 'a:end', 'b:start']);
});

test('a failed launch does not block later launches', async () => {
  const queue = createWindowLaunchQueue();
  const a = queue.enqueue(async () => {
    throw new Error('broken');
  });
  const b = queue.enqueue(async () => 'b');
  await expect(a).rejects.toThrow('broken');
  expect(await b).toBe('b');
});

test('a hung launch stops blocking the queue after the timeout', async () => {
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const queue = createWindowLaunchQueue({
    clearTimeoutImpl: () => {},
    setTimeoutImpl: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    timeoutMs: 15_000,
  });
  void queue.enqueue(() => new Promise<never>(() => {}));
  let secondStarted = false;
  const second = queue.enqueue(async () => {
    secondStarted = true;
    return 'second';
  });
  await flush();
  expect(secondStarted).toBe(false);
  expect(timers.map(({ delay }) => delay)).toEqual([15_000]);
  timers[0].callback();
  expect(await second).toBe('second');
});

test('keeps pending launches alive beyond queue timeouts and clears after settlement', async () => {
  const first = deferred<string>();
  let timeout: () => void = () => {};
  const queue = createWindowLaunchQueue({
    setTimeoutImpl: (callback, delay) => {
      expect(delay).toBe(60_000);
      timeout = callback;
      return 1;
    },
    clearTimeoutImpl: () => {},
  });
  const launched = queue.enqueue(() => first.promise);
  expect(queue.hasPending()).toBe(true);
  await flush();
  timeout();
  expect(queue.hasPending()).toBe(true);
  first.resolve('done');
  await launched;
  expect(queue.hasPending()).toBe(false);
});
