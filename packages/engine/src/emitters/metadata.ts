import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DomainConfig, EntityConfig } from '@memberjunction/loom-contracts';

export interface MetadataEmitterOptions {
  outputDir: string;
  domain: DomainConfig;
  data: Record<string, readonly Record<string, unknown>[]>;
  maxPartSize?: number;
}

export interface SyncMetadataRecord {
  primaryKey: Record<string, unknown>;
  fields: Record<string, unknown>;
  collections?: Record<string, unknown[]>;
  embeds?: Record<string, Record<string, unknown>>;
  extension?: { entity?: string; fields: Record<string, unknown> };
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
 * Supports composition axes: isA extensions, collections, and embeds are composed into parent records.
 */
export async function emitMetadata(options: MetadataEmitterOptions): Promise<string[]> {
  const writtenFiles: string[] = [];
  const maxPartSize = options.maxPartSize ?? 5000;

  await fs.mkdir(options.outputDir, { recursive: true });

  // 0. Identify composed child entities that are emitted within a parent record
  const composedChildEntities = new Set<string>();
  const isAChildrenByParent = new Map<string, Array<{ childEntityName: string; childCfg: EntityConfig }>>();

  for (const [entityName, entityCfg] of Object.entries(options.domain.entities)) {
    if (entityCfg.composition?.isA) {
      composedChildEntities.add(entityName);
      const parentName = entityCfg.composition.isA.parentEntity;
      let list = isAChildrenByParent.get(parentName);
      if (!list) {
        list = [];
        isAChildrenByParent.set(parentName, list);
      }
      list.push({ childEntityName: entityName, childCfg: entityCfg });
    }
    if (entityCfg.composition?.collections) {
      for (const col of Object.values(entityCfg.composition.collections)) {
        composedChildEntities.add(col.entity);
      }
    }
    if (entityCfg.composition?.embeds) {
      for (const emb of Object.values(entityCfg.composition.embeds)) {
        composedChildEntities.add(emb.entity);
      }
    }
  }

  // 1. Emit root .mj-sync.json for discovery by MetadataSync (findEntityDirectories)
  const topologicalEntityOrder = computeTopologicalOrder(options.domain);
  const directoryOrder: string[] = [];
  for (const entityKey of topologicalEntityOrder) {
    if (composedChildEntities.has(entityKey)) continue;
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

  // Pre-index child records for fast composition lookups
  const childRecordsByPk = new Map<string, Map<string, Record<string, unknown>>>();
  const childRecordsByFk = new Map<string, Map<string, Array<Record<string, unknown>>>>();

  for (const [eName, rows] of Object.entries(options.data)) {
    const pkMap = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const id = r['ID'] ?? r['id'];
      if (id !== undefined && id !== null) {
        pkMap.set(String(id).toLowerCase(), r as Record<string, unknown>);
      }
    }
    childRecordsByPk.set(eName, pkMap);
  }

  for (const parentCfg of Object.values(options.domain.entities)) {
    if (parentCfg.composition?.collections) {
      for (const col of Object.values(parentCfg.composition.collections)) {
        const cacheKey = `${col.entity}:${col.foreignKey}`;
        if (!childRecordsByFk.has(cacheKey)) {
          const fkMap = new Map<string, Array<Record<string, unknown>>>();
          const rows = options.data[col.entity] ?? [];
          for (const r of rows) {
            const fkVal = r[col.foreignKey];
            if (fkVal !== undefined && fkVal !== null) {
              const k = String(fkVal).toLowerCase();
              let list = fkMap.get(k);
              if (!list) {
                list = [];
                fkMap.set(k, list);
              }
              list.push(r as Record<string, unknown>);
            }
          }
          childRecordsByFk.set(cacheKey, fkMap);
        }
      }
    }
  }

  // 2. Emit entity directories directly under outputDir (single level for MetadataSync)
  for (const [entityName, records] of Object.entries(options.data)) {
    const entityCfg = options.domain.entities[entityName];
    if (!entityCfg) continue;
    if (composedChildEntities.has(entityName)) continue; // Omit composed child directories

    const dirName = entityCfg.outputDirectory ?? entityName;
    const entityDir = path.join(options.outputDir, dirName);

    await fs.mkdir(entityDir, { recursive: true });

    // Emit per-entity .mj-sync.json specifying target entityName and optional collections modes
    const syncConfigPath = path.join(entityDir, '.mj-sync.json');
    const syncConfig: Record<string, unknown> = {
      entity: entityCfg.entityName,
    };
    if (entityCfg.composition?.collections && Object.keys(entityCfg.composition.collections).length > 0) {
      const collectionsModeMap: Record<string, { mode: 'upsert' | 'authoritative' }> = {};
      for (const [colName, colCfg] of Object.entries(entityCfg.composition.collections)) {
        collectionsModeMap[colName] = {
          mode: colCfg.mode ?? 'upsert',
        };
      }
      syncConfig['collections'] = collectionsModeMap;
    }
    await fs.writeFile(syncConfigPath, JSON.stringify(syncConfig, null, 2) + '\n', 'utf8');
    writtenFiles.push(syncConfigPath);

    // Identify primary key field(s)
    const pkFields = Object.entries(entityCfg.fields)
      .filter(([_, f]) => f.isPrimaryKey)
      .map(([name]) => name);
    const pkField = pkFields[0] ?? 'ID';

    // Wrap records into { primaryKey, fields, extension, collections, embeds }
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

      const recId = String(primaryKey['ID'] ?? primaryKey['id'] ?? primaryKey[pkField] ?? '').toLowerCase();
      const wrapped: SyncMetadataRecord = { primaryKey, fields };

      // 1. Compose IsA extension
      const isAChildren = isAChildrenByParent.get(entityName);
      if (isAChildren && recId) {
        for (const { childEntityName, childCfg } of isAChildren) {
          const childRow = childRecordsByPk.get(childEntityName)?.get(recId);
          if (childRow) {
            const childPkFields = Object.entries(childCfg.fields)
              .filter(([_, f]) => f.isPrimaryKey)
              .map(([n]) => n);
            const childLeafFields: Record<string, unknown> = {};
            for (const [ck, cv] of Object.entries(childRow)) {
              if (ck === 'sync' || ck === 'ID' || ck === 'id' || childPkFields.includes(ck)) continue;
              childLeafFields[ck] = cv;
            }
            wrapped.extension = {
              entity: childCfg.entityName,
              fields: childLeafFields,
            };
          }
        }
      }

      // 2. Compose collections
      if (entityCfg.composition?.collections && recId) {
        for (const [colName, colCfg] of Object.entries(entityCfg.composition.collections)) {
          const cacheKey = `${colCfg.entity}:${colCfg.foreignKey}`;
          const matchingChildren = childRecordsByFk.get(cacheKey)?.get(recId) ?? [];
          const childCfg = options.domain.entities[colCfg.entity];
          const childPkFields = childCfg
            ? Object.entries(childCfg.fields).filter(([_, f]) => f.isPrimaryKey).map(([n]) => n)
            : ['ID'];
          const childPkField = childPkFields[0] ?? 'ID';

          const childElements: Array<{ primaryKey: Record<string, unknown>; fields: Record<string, unknown> }> = [];
          for (const child of matchingChildren) {
            const childPkVal = child[childPkField] ?? child['ID'] ?? child['id'];
            const childFields: Record<string, unknown> = {};
            for (const [ck, cv] of Object.entries(child)) {
              if (ck === 'sync' || ck === childPkField || childPkFields.includes(ck)) continue;
              childFields[ck] = cv;
            }
            childElements.push({
              primaryKey: { [childPkField]: childPkVal },
              fields: childFields,
            });
          }

          if (childElements.length > 0) {
            if (!wrapped.collections) wrapped.collections = {};
            wrapped.collections[colName] = childElements;
          }
        }
      }

      // 3. Compose embeds
      if (entityCfg.composition?.embeds) {
        for (const [embedField, embedCfg] of Object.entries(entityCfg.composition.embeds)) {
          const embedFkVal = r[embedField];
          if (embedFkVal !== undefined && embedFkVal !== null && embedFkVal !== '') {
            const childRow = childRecordsByPk.get(embedCfg.entity)?.get(String(embedFkVal).toLowerCase());
            if (childRow) {
              const childCfg = options.domain.entities[embedCfg.entity];
              const childPkFields = childCfg
                ? Object.entries(childCfg.fields).filter(([_, f]) => f.isPrimaryKey).map(([n]) => n)
                : ['ID'];
              const childPkField = childPkFields[0] ?? 'ID';
              const childPkVal = childRow[childPkField] ?? childRow['ID'] ?? childRow['id'];
              const childFields: Record<string, unknown> = {};
              for (const [ck, cv] of Object.entries(childRow)) {
                if (ck === 'sync' || ck === childPkField || childPkFields.includes(ck)) continue;
                childFields[ck] = cv;
              }
              if (!wrapped.embeds) wrapped.embeds = {};
              wrapped.embeds[embedField] = {
                primaryKey: { [childPkField]: childPkVal },
                fields: childFields,
              };
            }
          }
        }
      }

      return wrapped;
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
 * Preserves composition keys (extension, collections, embeds) without dropping them.
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
      const wrappedRecord = parsed[i];
      if (
        typeof wrappedRecord !== 'object' ||
        wrappedRecord === null ||
        !('primaryKey' in wrappedRecord) ||
        !('fields' in wrappedRecord) ||
        typeof wrappedRecord.primaryKey !== 'object' ||
        typeof wrappedRecord.fields !== 'object'
      ) {
        throw new Error(
          `Record at index ${i} in '${filePath}' lacks required { primaryKey, fields } wrapper`
        );
      }

      const row: Record<string, unknown> = {
        ...(wrappedRecord.primaryKey as Record<string, unknown>),
        ...(wrappedRecord.fields as Record<string, unknown>),
      };
      delete row.sync;

      const recObj = wrappedRecord as Record<string, unknown>;
      if (recObj['extension'] !== undefined) {
        row['extension'] = recObj['extension'];
      }
      if (recObj['collections'] !== undefined) {
        row['collections'] = recObj['collections'];
      }
      if (recObj['embeds'] !== undefined) {
        row['embeds'] = recObj['embeds'];
      }

      unwrappedRecords.push(row);
    }
  }

  return {
    entityName: syncConfig.entity,
    records: unwrappedRecords,
  };
}

/**
 * Decomposes composed records (extension, collections, embeds) from parent records
 * back into flat entity records for all entities in the domain.
 * Ensures simulation continuity and activeEntityIds tracking never lose composed children.
 */
export function extractComposedRecords(
  domain: DomainConfig,
  recordsByEntity: Record<string, readonly Record<string, unknown>[]>
): Record<string, Record<string, unknown>[]> {
  const result: Record<string, Record<string, unknown>[]> = {};

  // Initialize result with shallow copies of provided records
  for (const [e, rows] of Object.entries(recordsByEntity)) {
    result[e] = rows.map((r) => ({ ...r }));
  }

  // Ensure all domain entities have an entry
  for (const e of Object.keys(domain.entities)) {
    if (!result[e]) {
      result[e] = [];
    }
  }

  // 1. Extract isA extensions
  for (const [childEntityName, childCfg] of Object.entries(domain.entities)) {
    if (childCfg.composition?.isA) {
      const parentName = childCfg.composition.isA.parentEntity;
      const parentRows = result[parentName] ?? [];
      const childRows: Record<string, unknown>[] = [];
      const existingIds = new Set(result[childEntityName]?.map((r) => String(r['ID'] ?? r['id'])) ?? []);

      for (const pRow of parentRows) {
        const ext = pRow['extension'] as { fields?: Record<string, unknown> } | undefined;
        if (ext?.fields) {
          const pId = pRow['ID'] ?? pRow['id'];
          if (pId !== undefined && pId !== null && !existingIds.has(String(pId))) {
            const childRow: Record<string, unknown> = {
              ID: pId,
              ...ext.fields,
            };
            childRows.push(childRow);
            existingIds.add(String(pId));
          }
        }
      }
      result[childEntityName] = [...(result[childEntityName] ?? []), ...childRows];
    }
  }

  // 2. Extract collections
  for (const [parentEntityName, parentCfg] of Object.entries(domain.entities)) {
    if (parentCfg.composition?.collections) {
      const parentRows = result[parentEntityName] ?? [];
      for (const [colName, colCfg] of Object.entries(parentCfg.composition.collections)) {
        const childEntityName = colCfg.entity;
        const childRows: Record<string, unknown>[] = [];
        const existingIds = new Set(result[childEntityName]?.map((r) => String(r['ID'] ?? r['id'])) ?? []);

        for (const pRow of parentRows) {
          const pId = pRow['ID'] ?? pRow['id'];
          const cols = pRow['collections'] as Record<string, Array<{ primaryKey: Record<string, unknown>; fields: Record<string, unknown> }>> | undefined;
          const colList = cols?.[colName] ?? [];
          for (const entry of colList) {
            const childId = entry.primaryKey?.['ID'] ?? entry.primaryKey?.['id'] ?? entry.fields?.['ID'];
            if (childId !== undefined && childId !== null && !existingIds.has(String(childId))) {
              const childRow: Record<string, unknown> = {
                ...entry.primaryKey,
                ...entry.fields,
                [colCfg.foreignKey]: pId,
              };
              childRows.push(childRow);
              existingIds.add(String(childId));
            }
          }
        }
        result[childEntityName] = [...(result[childEntityName] ?? []), ...childRows];
      }
    }
  }

  // 3. Extract embeds
  for (const [parentEntityName, parentCfg] of Object.entries(domain.entities)) {
    if (parentCfg.composition?.embeds) {
      const parentRows = result[parentEntityName] ?? [];
      for (const [embedField, embedCfg] of Object.entries(parentCfg.composition.embeds)) {
        const childEntityName = embedCfg.entity;
        const childRows: Record<string, unknown>[] = [];
        const existingIds = new Set(result[childEntityName]?.map((r) => String(r['ID'] ?? r['id'])) ?? []);

        for (const pRow of parentRows) {
          const embeds = pRow['embeds'] as Record<string, { primaryKey: Record<string, unknown>; fields: Record<string, unknown> }> | undefined;
          const embeddedEntry = embeds?.[embedField];
          if (embeddedEntry) {
            const childId = embeddedEntry.primaryKey?.['ID'] ?? embeddedEntry.primaryKey?.['id'] ?? embeddedEntry.fields?.['ID'];
            if (childId !== undefined && childId !== null && !existingIds.has(String(childId))) {
              const childRow: Record<string, unknown> = {
                ...embeddedEntry.primaryKey,
                ...embeddedEntry.fields,
              };
              childRows.push(childRow);
              existingIds.add(String(childId));
            }
          }
        }
        result[childEntityName] = [...(result[childEntityName] ?? []), ...childRows];
      }
    }
  }

  return result;
}
