import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DomainConfig } from '@memberjunction/loom-contracts';

export interface MetadataEmitterOptions {
  outputDir: string;
  domain: DomainConfig;
  data: Record<string, readonly Record<string, unknown>[]>;
  maxPartSize?: number;
}

export interface SyncMetadataRecord {
  primaryKey: Record<string, unknown>;
  fields: Record<string, unknown>;
}

/**
 * Emits generated records into the standard MemberJunction /metadata/** directory structure
 * with .mj-sync.json configuration and { primaryKey, fields } wrappers for consumption by `mj sync push`.
 */
export async function emitMetadata(options: MetadataEmitterOptions): Promise<string[]> {
  const writtenFiles: string[] = [];
  const maxPartSize = options.maxPartSize ?? 5000;

  for (const [entityName, records] of Object.entries(options.data)) {
    const entityCfg = options.domain.entities[entityName];
    if (!entityCfg) continue;

    const pack = entityCfg.pack ?? 'default';
    const entityDir = path.join(options.outputDir, pack, entityName);

    await fs.mkdir(entityDir, { recursive: true });

    // 1. Emit .mj-sync.json specifying the target MemberJunction entityName
    const syncConfigPath = path.join(entityDir, '.mj-sync.json');
    const syncConfig = {
      entity: entityCfg.entityName,
    };
    await fs.writeFile(syncConfigPath, JSON.stringify(syncConfig, null, 2) + '\n', 'utf8');
    writtenFiles.push(syncConfigPath);

    // 2. Identify primary key field(s)
    const pkFields = Object.entries(entityCfg.fields)
      .filter(([_, f]) => f.isPrimaryKey)
      .map(([name]) => name);
    const pkField = pkFields[0] ?? 'ID';

    // 3. Wrap records into { primaryKey, fields }
    const wrappedRecords: SyncMetadataRecord[] = records.map((r) => {
      const primaryKey: Record<string, unknown> = {};
      const fields: Record<string, unknown> = {};

      for (const [k, v] of Object.entries(r)) {
        if (k === pkField || pkFields.includes(k)) {
          primaryKey[k] = v;
        } else {
          fields[k] = v;
        }
      }

      if (Object.keys(primaryKey).length === 0 && (r['ID'] !== undefined || r['id'] !== undefined)) {
        primaryKey['ID'] = r['ID'] ?? r['id'];
      }

      return { primaryKey, fields };
    });

    // 4. Partition into .part-*.json if records exceed maxPartSize, else single file
    if (wrappedRecords.length > maxPartSize) {
      const numParts = Math.ceil(wrappedRecords.length / maxPartSize);
      for (let p = 1; p <= numParts; p++) {
        const slice = wrappedRecords.slice((p - 1) * maxPartSize, p * maxPartSize);
        const fileName = `${entityName}.part-${String(p).padStart(2, '0')}.json`;
        const filePath = path.join(entityDir, fileName);
        await fs.writeFile(filePath, JSON.stringify(slice, null, 2) + '\n', 'utf8');
        writtenFiles.push(filePath);
      }
    } else {
      const fileName = `${entityName}.json`;
      const filePath = path.join(entityDir, fileName);
      await fs.writeFile(filePath, JSON.stringify(wrappedRecords, null, 2) + '\n', 'utf8');
      writtenFiles.push(filePath);
    }
  }

  return writtenFiles;
}

/**
 * Reads and unwraps records from an entity metadata directory.
 * Throws if .mj-sync.json is missing or records do not conform to { primaryKey, fields }.
 */
export async function readEntityMetadata(
  entityDir: string,
  expectedEntityName?: string
): Promise<{ entityName: string; records: Record<string, unknown>[] }> {
  const syncConfigPath = path.join(entityDir, '.mj-sync.json');
  let syncContent: string;
  try {
    syncContent = await fs.readFile(syncConfigPath, 'utf8');
  } catch {
    throw new Error(`Missing required '.mj-sync.json' in metadata directory '${entityDir}'`);
  }

  let syncConfig: { entity?: string };
  try {
    syncConfig = JSON.parse(syncContent);
  } catch (err) {
    throw new Error(`Invalid JSON in '.mj-sync.json' at '${syncConfigPath}': ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!syncConfig.entity || typeof syncConfig.entity !== 'string') {
    throw new Error(`'.mj-sync.json' at '${syncConfigPath}' must contain a valid string 'entity' property`);
  }

  if (expectedEntityName && syncConfig.entity !== expectedEntityName) {
    throw new Error(
      `'.mj-sync.json' at '${syncConfigPath}' declared entity '${syncConfig.entity}', expected '${expectedEntityName}'`
    );
  }

  const entries = await fs.readdir(entityDir);
  const dataFiles = entries
    .filter((f) => f.endsWith('.json') && f !== '.mj-sync.json' && f !== '.mj-folder.json')
    .sort();

  const unwrappedRecords: Record<string, unknown>[] = [];

  for (const file of dataFiles) {
    const filePath = path.join(entityDir, file);
    const content = await fs.readFile(filePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`Invalid JSON in metadata file '${filePath}': ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`Metadata file '${filePath}' must contain a JSON array of records`);
    }

    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (
        typeof item !== 'object' ||
        item === null ||
        !('primaryKey' in item) ||
        !('fields' in item) ||
        typeof item.primaryKey !== 'object' ||
        typeof item.fields !== 'object'
      ) {
        throw new Error(
          `Record at index ${i} in '${filePath}' lacks required { primaryKey, fields } wrapper`
        );
      }

      unwrappedRecords.push({
        ...(item.primaryKey as Record<string, unknown>),
        ...(item.fields as Record<string, unknown>),
      });
    }
  }

  return {
    entityName: syncConfig.entity,
    records: unwrappedRecords,
  };
}
