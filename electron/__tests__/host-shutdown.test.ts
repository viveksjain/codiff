import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
const { registerHostShutdown } = createRequire(import.meta.url)('../main/host-shutdown.cjs');
test('a canceled quit keeps remote hosts usable until windows accept closing', async () => {
  const app = Object.assign(new EventEmitter(), {
    quit: () => {
      quits++;
    },
  });
  let closes = 0;
  let quits = 0;
  let finishClose!: () => void;
  registerHostShutdown(
    app,
    {
      close: async () => {
        closes++;
        await new Promise<void>((resolve) => {
          finishClose = resolve;
        });
      },
    },
    () => {},
  );
  app.emit('before-quit', { preventDefault: () => {} });
  // Keep Editing cancels window unload, so Electron never emits will-quit.
  expect(closes).toBe(0);
  let prevented = 0;
  const event = {
    preventDefault: () => {
      prevented++;
    },
  };
  app.emit('will-quit', event);
  app.emit('will-quit', event);
  expect(closes).toBe(1);
  expect(prevented).toBe(2);
  expect(quits).toBe(0);
  finishClose();
  await new Promise((resolve) => setImmediate(resolve));
  expect(quits).toBe(1);
  app.emit('will-quit', event);
  expect(prevented).toBe(2);
});
