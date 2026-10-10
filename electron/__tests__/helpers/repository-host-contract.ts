import { basename, join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import type { RepositoryHost } from '../../host/repository-host.cjs';

export type HostFixture = {
  host: RepositoryHost;
  // A fresh, empty directory on the host's machine.
  root: string;
  [Symbol.asyncDispose](): Promise<void>;
};

const collect = (
  child: ReturnType<RepositoryHost['spawn']>,
): Promise<{ code: number | null; stderr: string; stdout: string }> =>
  new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr, stdout }));
    child.stdin.end();
  });

const createEntries = async ({ host, root }: HostFixture) => {
  await host.writeFile(join(root, 'file.txt'), 'hello');
  await host.exec('mkdir', [join(root, 'dir')]);
  await host.exec('ln', ['-s', 'file.txt', join(root, 'link')]);
};

export const defineRepositoryHostContract = (
  name: string,
  createFixture: () => Promise<HostFixture>,
) => {
  test(`${name}: exec returns stdout as a Buffer`, async () => {
    await using fixture = await createFixture();
    const output = await fixture.host.exec('printf', ['%s', 'héllo wörld']);
    expect(Buffer.isBuffer(output)).toBe(true);
    expect(output.toString('utf8')).toBe('héllo wörld');
  });

  test(`${name}: exec passes binary input through unchanged`, async () => {
    await using fixture = await createFixture();
    const input = Buffer.from([0, 1, 10, 13, 254, 255]);
    expect((await fixture.host.exec('cat', [], { input })).equals(input)).toBe(true);
  });

  test(`${name}: exec rejects with stderr when a command with input fails`, async () => {
    await using fixture = await createFixture();
    await expect(
      fixture.host.exec('/bin/sh', ['-c', 'echo boom >&2; exit 3'], { input: '' }),
    ).rejects.toThrow('boom');
  });

  test(`${name}: exec rejects when a command without input fails`, async () => {
    await using fixture = await createFixture();
    await expect(fixture.host.exec('/bin/sh', ['-c', 'exit 3'])).rejects.toThrow();
  });

  test(`${name}: exec runs in cwd and adds env on top of the host environment`, async () => {
    await using fixture = await createFixture();
    const output = await fixture.host.exec(
      '/bin/sh',
      [
        '-c',
        'pwd -P; printf "%s\\n" "$CODIFF_HOST_TEST"; command -v git >/dev/null && echo has-path',
      ],
      { cwd: fixture.root, env: { CODIFF_HOST_TEST: 'value with spaces' } },
    );
    expect(output.toString('utf8').trim().split('\n')).toEqual([
      await fixture.host.realpath(fixture.root),
      'value with spaces',
      'has-path',
    ]);
  });

  test(`${name}: exec rejects when aborted`, async () => {
    await using fixture = await createFixture();
    const controller = new AbortController();
    const started = Date.now();
    const result = fixture.host.exec('sleep', ['5'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(result).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test(`${name}: spawn streams output and reports the exit code`, async () => {
    await using fixture = await createFixture();
    const result = await collect(
      fixture.host.spawn('/bin/sh', ['-c', 'printf out; printf err >&2; exit 4']),
    );
    expect(result).toEqual({ code: 4, stderr: 'err', stdout: 'out' });
  });

  test(`${name}: lstat and stat report types, sizes and metadata`, async () => {
    await using fixture = await createFixture();
    await createEntries(fixture);
    const { host, root } = fixture;
    const file = await host.lstat(join(root, 'file.txt'));
    expect(file).toMatchObject({ size: 5, type: 'file' });
    expect(file.mode & 0o170000).toBe(0o100000);
    expect(file.mtimeMs).toBeGreaterThan(0);
    expect(file.ctimeMs).toBeGreaterThan(0);
    expect(file.ino).toBeGreaterThan(0);
    expect((await host.lstat(join(root, 'dir'))).type).toBe('directory');
    expect((await host.lstat(join(root, 'link'))).type).toBe('symlink');
    expect((await host.stat(join(root, 'link'))).type).toBe('file');
    await expect(host.lstat(join(root, 'missing'))).rejects.toThrow();
  });

  test(`${name}: lstatMany preserves order and returns null for missing paths`, async () => {
    await using fixture = await createFixture();
    await createEntries(fixture);
    const { host, root } = fixture;
    const stats = await host.lstatMany([
      join(root, 'file.txt'),
      join(root, 'missing'),
      join(root, 'dir'),
    ]);
    expect(stats.map((stat) => stat?.type ?? null)).toEqual(['file', null, 'directory']);
    expect(await host.lstatMany([])).toEqual([]);
  });

  test(`${name}: readFile and readFiles return bytes and per-path errors`, async () => {
    await using fixture = await createFixture();
    const { host, root } = fixture;
    const bytes = Buffer.from([0, 255, 10, 128]);
    await host.writeFile(join(root, 'binary.bin'), bytes);
    expect((await host.readFile(join(root, 'binary.bin'))).equals(bytes)).toBe(true);
    const [present, missing] = await host.readFiles([
      join(root, 'binary.bin'),
      join(root, 'missing'),
    ]);
    expect(Buffer.isBuffer(present) && present.equals(bytes)).toBe(true);
    expect(missing).toBeInstanceOf(Error);
    await expect(host.readFile(join(root, 'missing'))).rejects.toThrow();
  });

  test(`${name}: readlink and realpath resolve symlinks`, async () => {
    await using fixture = await createFixture();
    await createEntries(fixture);
    const { host, root } = fixture;
    expect(await host.readlink(join(root, 'link'))).toBe('file.txt');
    expect(await host.realpath(join(root, 'link'))).toBe(
      await host.realpath(join(root, 'file.txt')),
    );
  });

  test(`${name}: exclusive writeFile applies the mode and refuses to overwrite`, async () => {
    await using fixture = await createFixture();
    const { host, root } = fixture;
    const path = join(root, 'script.sh');
    await host.writeFile(path, '#!/bin/sh\n', { exclusive: true, mode: 0o755 });
    expect((await host.stat(path)).mode & 0o777).toBe(0o755);
    await expect(host.writeFile(path, 'again', { exclusive: true, mode: 0o644 })).rejects.toThrow();
    expect((await host.readFile(path)).toString('utf8')).toBe('#!/bin/sh\n');
  });

  test(`${name}: rename, rm and mkdtemp manage files on the host`, async () => {
    await using fixture = await createFixture();
    const { host, root } = fixture;
    await host.writeFile(join(root, 'a.txt'), 'a');
    await host.rename(join(root, 'a.txt'), join(root, 'b.txt'));
    expect((await host.readFile(join(root, 'b.txt'))).toString('utf8')).toBe('a');
    await expect(host.lstat(join(root, 'a.txt'))).rejects.toThrow();

    const temporary = await host.mkdtemp('codiff-host-contract-');
    expect(basename(temporary).startsWith('codiff-host-contract-')).toBe(true);
    await host.writeFile(join(temporary, 'nested.txt'), 'x');
    expect((await host.lstat(temporary)).type).toBe('directory');
    await host.rm(temporary, { force: true, recursive: true });
    await expect(host.lstat(temporary)).rejects.toThrow();
    await host.rm(join(root, 'never-existed'), { force: true });
  });
};
