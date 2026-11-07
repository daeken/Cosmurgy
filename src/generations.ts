import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

/** Bundle the whole local import graph, so editing a dependency also takes effect. */
export class Generations {
  readonly root: string;
  readonly directory: string;
  constructor(root: string, directory: string) { this.root = root; this.directory = directory; }
  async compile(entry: string): Promise<URL> {
    await mkdir(this.directory, { recursive: true });
    const file = join(this.directory, `${randomUUID()}.mjs`);
    const result = await build({ entryPoints: [resolve(this.root, entry)], absWorkingDir: this.root,
      outfile: file, bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24',
      packages: 'external', sourcemap: 'inline', logLevel: 'silent',
      plugins: [{ name: 'guard-native-actions', setup: builder => {
        const require = createRequire(join(this.root, 'package.json'));
        builder.onResolve({ filter: /^[^./]/ }, args => {
          if (args.path === 'jonui' || args.path.startsWith('node:')) return;
          return { path: require.resolve(args.path), external: true };
        });
        builder.onResolve({ filter: /^jonui$/ }, args => {
          if (args.importer === join(this.root, 'src', 'ui.ts')) return { path: 'jonui', external: true };
          return { path: join(this.root, 'src', 'ui.ts') };
        });
      } }],
    });
    await writeFile(file, result.outputFiles[0].contents);
    return pathToFileURL(file);
  }
  async load<T>(entry: string): Promise<T> {
    return import((await this.compile(entry)).href) as Promise<T>;
  }
}
