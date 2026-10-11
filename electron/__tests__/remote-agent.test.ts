import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vite-plus/test';
const require = createRequire(import.meta.url);
const { createLocalHost } = require('../host/local-host.cjs');
const { getAgentForHost } = require('../agent.cjs');
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

test('remote OpenCode reports text progress across split UTF-8 events before close', async () => {
  const { createCommandTransport } = await import('./helpers/command-transport.ts');
  const progress = vi.fn();
  let beforeClose: unknown[] = [];
  let beforeText = 0;
  const { transport } = createCommandTransport(({ process, stdin, close }) => {
    stdin.on('finish', () => {
      process.stdout?.write('startup noise\n' + JSON.stringify({ type: 'step_start' }) + '\n');
      const output = Buffer.from(
        JSON.stringify({ type: 'text', part: { id: 'one', text: '{"reply":"héllo"}' } }) + '\n',
      );
      const split = output.indexOf(Buffer.from('é')) + 1;
      process.stdout?.write(output.subarray(0, split));
      beforeText = progress.mock.calls.length;
      process.stdout?.write(output.subarray(split));
      beforeClose = progress.mock.calls.map(([phase]) => phase);
      close();
    });
  });
  const host = {
    ...createLocalHost(),
    id: 'ssh://remote',
    label: 'remote',
    getEnvironment: async () => ({ HOME: '/remote', PATH: '/bin' }),
    resolveCommand: async () => '/bin/opencode',
    spawn: (_command: string, args: ReadonlyArray<string>, options: unknown) =>
      transport.spawn(transport.command, args, options as Parameters<typeof transport.spawn>[2]),
  };
  const output = await getAgentForHost(host, 'opencode').run(
    '/remote/repo',
    'prompt',
    {},
    undefined,
    undefined,
    { onProgress: progress },
  );
  expect(beforeText).toBe(0);
  expect(beforeClose).toEqual(['response-received']);
  expect(output).toBe('{"reply":"héllo"}');
});
