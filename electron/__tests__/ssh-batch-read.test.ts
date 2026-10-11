import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, vi } from 'vite-plus/test';
const { buildReadFilesScript, parseReadFilesOutput } = createRequire(import.meta.url)(
  '../host/ssh-host.cjs',
);
const execFileAsync = promisify(execFile);
for (const accelerated of [true, false]) {
  test(`batch reads keep binary/error frames with optional acceleration=${accelerated}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'codiff-batch-read-'));
    try {
      const bin = join(root, 'bin');
      await mkdir(bin);
      const log = join(root, 'wc-calls');
      await writeFile(log, '');
      for (const tool of ['cat', 'head', 'tr']) {
        const { stdout } = await execFileAsync('/bin/sh', ['-c', 'command -v "$1"', 'sh', tool]);
        await symlink(stdout.trim(), join(bin, tool));
      }
      await writeFile(join(bin, 'wc'), `#!/bin/sh\nprintf x >> '${log}'\nexec /usr/bin/wc "$@"\n`, {
        mode: 0o700,
      });
      if (accelerated) await symlink('/usr/bin/perl', join(bin, 'perl'));
      const bytes = Buffer.from([0, 255, 10, 128, 0]);
      const file = join(root, 'héllo\nfile');
      await writeFile(file, bytes);
      const empty = join(root, 'empty');
      await writeFile(empty, '');
      const fifo = join(root, 'fifo');
      await execFileAsync('mkfifo', [fifo]);
      const linked = join(root, 'linked');
      await symlink(file, linked);
      const paths = [file, empty, join(root, 'missing'), bin, linked, fifo];
      const { stdout } = await execFileAsync('/bin/sh', ['-c', buildReadFilesScript(paths)], {
        env: { ...process.env, PATH: bin },
        encoding: 'buffer',
        timeout: 1000,
      });
      const output = parseReadFilesOutput(stdout, paths);
      expect(output[0]).toEqual(bytes);
      expect(output[1]).toEqual(Buffer.alloc(0));
      expect(output[2]).toBeInstanceOf(Error);
      expect(output[3]).toBeInstanceOf(Error);
      expect(output[4]).toEqual(bytes);
      expect(output[5]).toBeInstanceOf(Error);
      expect((await readFile(log)).length).toBe(accelerated ? 0 : 3);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
}

for (const method of ['readFiles', 'lstatMany']) {
  test(`${method} batches overlap but return results in path order`, async () => {
    const { createSshHost, chunkByScriptSize } = createRequire(import.meta.url)(
      '../host/ssh-host.cjs',
    );
    const paths = Array.from({ length: 600 }, (_, index) => `/tmp/${'x'.repeat(120)}/${index}`);
    const chunks: Array<Array<string>> = chunkByScriptSize(paths);
    let launched = 0;
    const host = createSshHost({
      alias: 'test',
      dialect: 'posix',
      statFlavor: 'bsd',
      connection: {
        ensureMaster: async () => {},
        check: async () => true,
        exitMaster: async () => {},
        spawnClient: () => {
          const index = launched++;
          const output = chunks[index]
            .map(() =>
              method === 'readFiles'
                ? `OK 1\n${index}`
                : `OK 81a4 1 ${index + 1} 1700000000 1700000000\n`,
            )
            .join('');
          return spawn(
            process.execPath,
            [
              '-e',
              `setTimeout(()=>process.stdout.write(${JSON.stringify(output)}),${index === 0 ? 1000 : 0})`,
            ],
            { stdio: ['pipe', 'pipe', 'pipe'] },
          );
        },
      },
    });
    const pending = host[method](paths);
    try {
      await vi.waitFor(() => expect(launched).toBe(chunks.length), { timeout: 250 });
      const output = await pending;
      expect(
        output.map((value: Buffer | { ino: number }) =>
          Buffer.isBuffer(value) ? value.toString() : String(value.ino - 1),
        ),
      ).toEqual(chunks.flatMap((chunk, index) => chunk.map(() => String(index))));
    } finally {
      await pending;
      await host.close();
    }
  });
}
