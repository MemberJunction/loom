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
 * Computes topological ordering of domain entities based on foreign key dependencies
 * and pack dependencies. Parent entities appear before child entities.
 */
export function computeTopologicalOrder(domain: DomainConfig): string[] {
  const entityNames = Object.keys(domain.entities);
  const adj = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();

  for (const name of entityNames) {
    adj.set(name, new Set());
    inDegree.set(name, 0);
  }

  // Edge from parent -> child (parent must be created before child)
  for (const [entityName, entityCfg] of Object.entries(domain.entities)) {
    for (const fk of Object.values(entityCfg.foreignKeys ?? {})) {
      const target = fk.targetEntity;
      if (domain.entities[target] && target !== entityName) {
        if (!adj.get(target)!.has(entityName)) {
          adj.get(target)!.add(entityName);
          inDegree.set(entityName, (inDegree.get(entityName) ?? 0) + 1);
        }
      }
    }
  }

  // Enforce pack dependencies: parentPack entities -> childPack entities
  for (const [entityName, entityCfg] of Object.entries(domain.entities)) {
    const pack = domain.packs[entityCfg.pack];
    if (pack?.dependsOn) {
      for (const parentPackName of pack.dependsOn) {
        for (const [otherName, otherCfg] of Object.entries(domain.entities)) {
          if (otherCfg.pack === parentPackName && otherName !== entityName) {
            if (!adj.get(otherName)!.has(entityName)) {
              adj.get(otherName)!.add(entityName);
              inDegree.set(entityName, (inDegree.get(entityName) ?? 0) + 1);
            }
          }
        }
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [name, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(name);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of adj.get(u) ?? []) {
      const newDeg = (inDegree.get(v) ?? 1) - 1;
      inDegree.set(v, newDeg);
      if (newDeg === 0) queue.push(v);
    }
  }

  // Append any entities not yet in order (e.g. if circular)
  for (const name of entityNames) {
    if (!order.includes(name)) order.push(name);
  }

  return order;
}

/**
 * Emits generated records into the standard MemberJunction /metadata/** directory structure
 * with root .mj-sync.json (directoryOrder in topological sequence, autoCreateMissingRecords)
 * and per-entity single-level directories with .mj-sync.json and { primaryKey, fields } wrappers.
 */
export async function emitMetadata(options: MetadataEmitterOptions): Promise<string[]> {
  const writtenFiles: string[] = [];
  const maxPartSize = options.maxPartSize ?? 5000;

  await fs.mkdir(options.outputDir, { recursive: true });

  // 1. Emit root .mj-sync.json for discovery by MetadataSync (findEntityDirectories)
  const topologicalEntityOrder = computeTopologicalOrder(options.domain);
  const directoryOrder: string[] = [];
  for (const entityKey of topologicalEntityOrder) {
    const dir = options.domain.entities[entityKey]?.outputDirectory ?? entityKey;
    if (!directoryOrder.includes(dir)) {
      directoryOrder.push(dir);
    }
  }
  const rootSyncConfigPath = path.join(options.outputDir, '.mj-sync.json');
  const rootSyncConfig = {
    directoryOrder,
    push: {
      autoCreateMissingRecords: true,
    },
  };
  await fs.writeFile(rootSyncConfigPath, JSON.stringify(rootSyncConfig, null, 2) + '\n', 'utf8');
  writtenFiles.push(rootSyncConfigPath);

  // 2. Emit entity directories directly under outputDir (single level for MetadataSync)
  for (const [entityName, records] of Object.entries(options.data)) {
    const entityCfg = options.domain.entities[entityName];
    if (!entityCfg) continue;

    const dirName = entityCfg.outputDirectory ?? entityName;
    const entityDir = path.join(options.outputDir, dirName);

    await fs.mkdir(entityDir, { recursive: true });

    // Emit per-entity .mj-sync.json specifying the target MemberJunction entityName
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

    // 3. Wrap records into { primaryKey, fields } (never commit sync blocks)
    const wrappedRecords: SyncMetadataRecord[] = records.map((r) => {
      const primaryKey: Record<string, unknown> = {};
      const fields: Record<string, unknown> = {};

      for (const [k, v] of Object.entries(r)) {
        if (k === 'sync') continue;
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

    // Filename determination: outputFileName override or dot-prefixed outputDirectory, else entityName
    let baseFileName = entityName;
    if (entityCfg.outputFileName) {
      baseFileName = entityCfg.outputFileName.endsWith('.json')
        ? entityCfg.outputFileName.slice(0, -5)
        : entityCfg.outputFileName;
    } else if (entityCfg.outputDirectory) {
      baseFileName = `.${entityCfg.outputDirectory}`;
    }

    // 4. Partition into .part-*.json if records exceed maxPartSize, else single file
    if (wrappedRecords.length > maxPartSize) {
      const numParts = Math.ceil(wrappedRecords.length / maxPartSize);
      for (let p = 1; p <= numParts; p++) {
        const slice = wrappedRecords.slice((p - 1) * maxPartSize, p * maxPartSize);
        const fileName = `${baseFileName}.part-${String(p).padStart(2, '0')}.json`;
        const filePath = path.join(entityDir, fileName);
        await fs.writeFile(filePath, JSON.stringify(slice, null, 2) + '\n', 'utf8');
        writtenFiles.push(filePath);
      }
    } else {
      const fileName = `${baseFileName}.json`;
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

      const row: Record<string, unknown> = {
        ...(item.primaryKey as Record<string, unknown>),
        ...(item.fields as Record<string, unknown>),
      };
      delete row.sync;
      unwrappedRecords.push(row);
    }
  }

  return {
    entityName: syncConfig.entity,
    records: unwrappedRecords,
  };
}
