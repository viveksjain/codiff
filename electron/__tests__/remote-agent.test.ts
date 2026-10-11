import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { expect, test } from 'vite-plus/test';
const { getAgentForHost } = createRequire(import.meta.url)('../agent.cjs');
test('missing configured remote backend names its command and host without fallback', async () => {
  const resolved: Array<string> = [];
  const host = {
    id: 'ssh://devbox',
    label: 'devbox',
    getEnvironment: async () => ({ HOME: '/remote', PATH: '/remote/bin' }),
    resolveCommand: async (name: string) => {
      resolved.push(name);
      return null;
    },
  };
  const agent = getAgentForHost(host, 'claude');
  expect(await agent.isAvailable()).toBe(false);
  await expect(agent.run('/repo', 'prompt', {})).rejects.toMatchObject({
    code: 'CLAUDE_NOT_FOUND',
    message: "claude isn't installed on devbox.",
  });
  expect(resolved.every((name) => name === 'claude')).toBe(true);
});
test('remote runs use only their environment and cwd through host spawn', async () => {
  let launch: unknown;
  const environment = { HOME: '/remote/home', PATH: '/remote/bin', REMOTE_TOKEN: 'remote-only' };
  const host = {
    id: 'ssh://devbox',
    label: 'devbox',
    getEnvironment: async () => environment,
    resolveCommand: async () => '/remote/bin/claude',
    spawn: (command: string, args: Array<string>, options: unknown) => {
      launch = { command, args, options };
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => {},
      });
      child.stdin.on('finish', () => {
        child.stdout.end(JSON.stringify({ structured_output: { reply: 'remote' } }));
        child.emit('close', 0);
      });
      return child;
    },
  };
  expect(
    await getAgentForHost(host, 'claude').run(
      '/remote/repo',
      'prompt',
      {},
      undefined,
      undefined,
      {},
    ),
  ).toBe('{"reply":"remote"}');
  expect(launch).toMatchObject({
    command: '/remote/bin/claude',
    options: { cwd: '/remote/repo', env: environment },
  });
});
