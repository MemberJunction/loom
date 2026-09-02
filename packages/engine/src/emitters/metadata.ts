import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DomainConfig } from '@memberjunction/loom-contracts';

export interface MetadataEmitterOptions {
  outputDir: string;
  domain: DomainConfig;
  data: Record<string, readonly Record<string, unknown>[]>;
}

/**
 * Emits generated records into the standard MemberJunction /metadata/** directory structure
 * for consumption by `mj sync push`.
 */
export async function emitMetadata(options: MetadataEmitterOptions): Promise<string[]> {
  const writtenFiles: string[] = [];

  for (const [entityName, records] of Object.entries(options.data)) {
    const entityCfg = options.domain.entities[entityName];
    const pack = entityCfg?.pack ?? 'default';
    const targetDir = path.join(options.outputDir, pack);

    await fs.mkdir(targetDir, { recursive: true });

    const filePath = path.join(targetDir, `${entityName}.json`);
    const content = JSON.stringify(records, null, 2);
    await fs.writeFile(filePath, content, 'utf8');

    writtenFiles.push(filePath);
  }

  return writtenFiles;
}
