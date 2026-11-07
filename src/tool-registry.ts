import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool } from './contracts.ts';
import type { Generations } from './generations.ts';

export async function loadTools(loader: Generations, directory = 'src/tools'): Promise<ReadonlyMap<string, Tool>> {
  const registry = new Map<string, Tool>();
  const files = (await readdir(join(loader.root, directory))).filter(file => file.endsWith('.ts')).sort();
  for (const file of files) {
    const module = await loader.load<{ tools?: Tool[]; default?: Tool }>(join(directory, file));
    const tools = module.tools ?? (module.default ? [module.default] : []);
    if (!tools.length) throw new Error(`${file} must export a default tool or a tools array.`);
    for (const tool of tools) {
      if (!/^[A-Za-z_$][\w$]*$/.test(tool.name) || !tool.description || !tool.signature || typeof tool.run !== 'function') {
        throw new Error(`Invalid tool definition in ${file}.`);
      }
      if (registry.has(tool.name)) throw new Error(`Duplicate tool '${tool.name}'.`);
      registry.set(tool.name, tool);
    }
  }
  return registry;
}
