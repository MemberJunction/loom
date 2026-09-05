import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadProject } from '../project.js';
import { applyFieldGenerators } from '@memberjunction/loom-engine';

export interface DecorateCommandOptions {
  project?: string;
  config?: string;
  dir?: string;
}

export async function executeDecorate(options: DecorateCommandOptions): Promise<void> {
  const projectPath = options.config ?? options.project;
  if (!projectPath) {
    throw new Error('Decorate: either --project or --config must be provided');
  }
  const loaded = await loadProject(projectPath);
  const dataDir = options.dir
    ? path.resolve(process.cwd(), options.dir)
    : path.resolve(loaded.projectDir, loaded.manifest.output.metadataDir);

  console.log(`🧵 Loom Decorate: applying avatar/logo generators for '${loaded.domain.name}'`);
  console.log(`   Target: ${dataDir}`);

  const unwrapped: Record<string, Record<string, unknown>[]> = {};
  const fileMap: Record<string, { file: string; wrapped: Array<{ primaryKey: Record<string, unknown>; fields: Record<string, unknown> }> }[]> = {};

  for (const [entityName, entityCfg] of Object.entries(loaded.domain.entities)) {
    const dirName = entityCfg.outputDirectory ?? entityName;
    const entityDir = path.join(dataDir, dirName);
    if (!fs.existsSync(entityDir)) continue;
    const files = fs.readdirSync(entityDir).filter((f) => f.endsWith('.json') && f !== '.mj-sync.json' && f !== '.mj-folder.json').sort();
    unwrapped[entityName] = [];
    fileMap[entityName] = [];
    for (const file of files) {
      const full = path.join(entityDir, file);
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!Array.isArray(parsed)) continue;
      const wrapped = parsed as Array<{ primaryKey: Record<string, unknown>; fields: Record<string, unknown> }>;
      fileMap[entityName]!.push({ file: full, wrapped });
      for (const rec of wrapped) {
        unwrapped[entityName]!.push({ ...(rec.primaryKey ?? {}), ...(rec.fields ?? {}) });
      }
    }
  }

  const decorated = applyFieldGenerators(loaded.domain, unwrapped);

  for (const [entityName] of Object.entries(loaded.domain.entities)) {
    const files = fileMap[entityName] ?? [];
    let offset = 0;
    const rows = decorated[entityName] ?? [];
    for (const { file, wrapped } of files) {
      for (let i = 0; i < wrapped.length; i++) {
        const src = rows[offset + i];
        if (!src) continue;
        const fields = wrapped[i]!.fields ?? {};
        for (const key of Object.keys(src)) {
          if (wrapped[i]!.primaryKey && key in wrapped[i]!.primaryKey) continue;
          fields[key] = src[key];
        }
        wrapped[i]!.fields = fields;
      }
      fs.writeFileSync(file, JSON.stringify(wrapped, null, 2) + '\n');
      offset += wrapped.length;
    }
  }

  console.log(`✨ Decorate complete.`);
}
