import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
const { createSshHost } = createRequire(import.meta.url)('../host/ssh-host.cjs');
test('remote environment is host-scoped, cached, and keeps noise and value bytes separate', async () => {
  const hosts = ['first', 'second'].map((alias) => {
    const commands: Array<string> = [];
    const inputs: Array<string> = [];
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
            : command.includes('mktemp')
              ? `/tmp/codiff-environment-${alias}\n`
              : command.includes('cat >&3') || command.includes('rm -rf')
                ? ''
                : `startup noise\n__CODIFF_LOGIN_SHELL_ENVIRONMENT__HOME=/remote/${alias}\0PATH=/remote/${alias}/bin\0REMOTE_SECRET=a=b\né\0`;
          const child = spawn(
            process.execPath,
            ['-e', `process.stdout.write(${JSON.stringify(output)})`],
            { stdio: ['pipe', 'pipe', 'pipe'] },
          );
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = ((chunk: Buffer | string, ...rest: Array<never>) => {
            inputs.push(chunk.toString());
            return write(chunk, ...rest);
          }) as typeof child.stdin.write;
          return child;
        },
      },
    });
    return { host, commands, inputs };
  });
  try {
    for (const { host, commands, inputs } of hosts) {
      const [one, two] = await Promise.all([host.getEnvironment(), host.getEnvironment()]);
      expect(one).toBe(two);
      expect(one).toMatchObject({ HOME: `/remote/${host.label}`, REMOTE_SECRET: 'a=b\né' });
      // One login shell read, then the launcher script's directory and contents.
      expect(commands).toHaveLength(3);
      expect(inputs.join('')).toContain(`PATH=/remote/${host.label}/bin`);
      expect(await host.resolveCommand('codex')).toBe(`/remote/${host.label}/codex`);
      // The login environment reaches the command through the launcher, not the argument.
      expect(commands[3]).toContain(`/tmp/codiff-environment-${host.label}/launch.sh`);
      expect(commands[3]).not.toContain(`/remote/${host.label}/bin`);
    }
  } finally {
    await Promise.all(hosts.map(({ host }) => host.close()));
  }
});
