import { EventEmitter } from 'node:events';
import { expect, test } from 'vite-plus/test';
import { createRemoteHandoff } from '../../bin/remote-handoff.js';
test('failed Electron handoff cleans up only a master owned by this CLI', async () => {
  for (const adopted of [false, true]) {
    let exits = 0;
    const handoff = createRemoteHandoff(
      {
        exitMaster: async () => {
          exits++;
        },
      },
      adopted,
    );
    const child = new EventEmitter();
    const launched = handoff.launch(() => child);
    child.emit('error', new Error('Electron missing'));
    await expect(launched).rejects.toThrow('Electron missing');
    await handoff.cleanup();
    await handoff.cleanup();
    expect(exits).toBe(adopted ? 0 : 1);
  }
});
test('pre-launch errors release ownership while successful spawn hands it to the app', async () => {
  let exits = 0;
  const connection = {
    exitMaster: async () => {
      exits++;
    },
  };
  const beforeLaunch = createRemoteHandoff(connection, false);
  await beforeLaunch.cleanup();
  expect(exits).toBe(1);
  const handoff = createRemoteHandoff(connection, false);
  const child = new EventEmitter();
  const launched = handoff.launch(() => child);
  child.emit('spawn');
  expect(await launched).toBe(child);
  await handoff.cleanup();
  expect(exits).toBe(1);
});
