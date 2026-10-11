import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
const { createSshHost } = createRequire(import.meta.url)('../host/ssh-host.cjs');
test('remote environment is host-scoped, cached, and keeps noise and value bytes separate', async () => {
  const hosts = ['first', 'second'].map((alias) => {
    const commands: Array<string> = [];
    const host = createSshHost({
      alias,
      dialect: 'posix',
      statFlavor: 'bsd',
      connection: {
        ensureMaster: async () => {},
        check: async () => true,
        exitMaster: async () => {},
        spawnClient: (command: string) => {
          commands.push(command);
          const output = command.includes('command -v')
            ? `/remote/${alias}/codex\n`
            : `startup noise\n__CODIFF_LOGIN_SHELL_ENVIRONMENT__HOME=/remote/${alias}\0PATH=/remote/${alias}/bin\0REMOTE_SECRET=a=b\né\0`;
          return spawn(
            process.execPath,
            ['-e', `process.stdout.write(${JSON.stringify(output)})`],
            { stdio: ['pipe', 'pipe', 'pipe'] },
          );
        },
      },
    });
    return { host, commands };
  });
  try {
    for (const { host, commands } of hosts) {
      const [one, two] = await Promise.all([host.getEnvironment(), host.getEnvironment()]);
      expect(one).toBe(two);
      expect(one).toMatchObject({ HOME: `/remote/${host.label}`, REMOTE_SECRET: 'a=b\né' });
      expect(commands).toHaveLength(1);
      expect(await host.resolveCommand('codex')).toBe(`/remote/${host.label}/codex`);
      expect(commands[1]).toContain(`/remote/${host.label}/bin`);
    }
  } finally {
    await Promise.all(hosts.map(({ host }) => host.close()));
  }
});
