import { once } from 'node:events';

// Ownership remains with the CLI until Electron has actually spawned.
export const createRemoteHandoff = (connection, adopted) => {
  let owned = !adopted;
  return {
    cleanup: async () => {
      if (owned) {
        owned = false;
        await connection.exitMaster().catch(() => {});
      }
    },
    launch: async (spawn) => {
      const child = spawn();
      await once(child, 'spawn');
      owned = false;
      return child;
    },
  };
};
