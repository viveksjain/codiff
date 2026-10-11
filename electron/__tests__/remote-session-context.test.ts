import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
const require = createRequire(import.meta.url);
const sessionId = '019e5e57-e7d6-7392-9ad1-ad959319d2fb';
for (const [backend, name, override, subdir] of [
  ['claude', 'Claude', 'CLAUDE_CONFIG_DIR', 'projects'],
  ['codex', 'Codex', 'CODEX_HOME', 'sessions'],
  ['pi', 'Pi', 'PI_HOME', 'agent/sessions'],
]) {
  test(`${backend} session context belongs to its host even for the same session ID`, async () => {
    const reader = require(`../${backend}-session-context.cjs`)[`read${name}SessionContext`];
    for (const label of ['first', 'second']) {
      const root = '/remote/shared/config space';
      const file = `${root}/${subdir}/${sessionId}.jsonl`;
      const record =
        backend === 'codex'
          ? {
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: label }],
              },
            }
          : {
              type: backend === 'pi' ? 'message' : 'user',
              message: { role: 'user', content: label },
            };
      const content = Buffer.from(`${JSON.stringify(record)}\n`);
      const calls: Array<string> = [];
      const host = {
        id: `ssh://${label}`,
        label,
        getEnvironment: async () => ({ HOME: '/remote/shared', [override]: root }),
        readdir: async (path: string) => {
          expect(path).toBe(`${root}/${subdir}`);
          return [{ name: `${sessionId}.jsonl`, type: 'file' }];
        },
        stat: async (path: string) => {
          expect(path).toBe(file);
          return { type: 'file', size: content.length };
        },
        readFileTail: async (path: string, bytes: number) => {
          calls.push(path);
          return content.subarray(-bytes);
        },
      };
      expect(await reader(host, sessionId)).toMatchObject({
        messages: [{ role: 'user', text: label }],
      });
      expect(calls).toEqual([file]);
    }
  });
}

for (const [backend, name] of [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
  ['pi', 'Pi'],
  ['opencode', 'OpenCode'],
]) {
  test(`${backend} session context propagates a disconnected host`, async () => {
    const { HostDisconnectedError } = require('../host/host-errors.cjs');
    const error = new HostDisconnectedError('remote');
    const reader = require(`../${backend}-session-context.cjs`)[`read${name}SessionContext`];
    const host = {
      id: 'ssh://remote',
      label: 'remote',
      getEnvironment: async () => ({ HOME: '/remote', PATH: '/bin' }),
      readdir: async () => {
        throw error;
      },
      resolveCommand: async () => {
        throw error;
      },
    };
    await expect(
      reader(host, backend === 'opencode' ? 'ses_abcdefgh1234' : sessionId),
    ).rejects.toBe(error);
  });
}
