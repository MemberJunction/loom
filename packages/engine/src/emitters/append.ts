import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as path from 'node:path';
import type { DomainConfig, EntityConfig } from '@memberjunction/loom-contracts';
import { ExtractPrimaryKey } from '../identity/primaryKey.js';
import {
  computeComposedChildEntities,
  computeDirectoryOrder,
  computeTopologicalOrder,
  createRecordComposer,
  type SyncMetadataRecord,
} from './metadata.js';

export interface AppendMetadataOptions {
  /** Directory to write. When it differs from priorDir, the prior tree is copied there first. */
  outputDir: string;
  /** The committed metadata tree the prior records were read from. */
  priorDir: string;
  domain: DomainConfig;
  /** Flat prior records by entity (after extractComposedRecords). */
  priorRecords: Record<string, readonly Record<string, unknown>[]>;
  /** Flat current records by entity: every prior record plus new ones, with any field changes applied. */
  currentRecords: Record<string, readonly Record<string, unknown>[]>;
  maxPartSize?: number;
}

export interface AppendMetadataResult {
  writtenFiles: string[];
  /** New records written, by entity. */
  appendedCounts: Record<string, number>;
  /** Prior records whose fields were updated in place, by entity. */
  updatedCounts: Record<string, number>;
}

/** Keys on a flat row that hold composed children, not fields. */
const COMPOSITION_KEYS = new Set(['collections', 'extension', 'embeds', 'sync']);

interface LoadedFile {
  filePath: string;
  records: SyncMetadataRecord[];
  trailingNewline: boolean;
  dirty: boolean;
}

interface LoadedDir {
  dirPath: string;
  existed: boolean;
  files: LoadedFile[];
}

interface IndexedNode {
  node: SyncMetadataRecord | NonNullable<SyncMetadataRecord['extension']>;
  file: LoadedFile;
}

/**
 * Writes an accumulation cycle onto an existing metadata tree without rewriting what is already there.
 *
 * Prior records stay byte-for-byte as committed (including MetadataSync's `sync` blocks, nested child order,
 * and each directory's own .mj-sync.json). New records are appended: root records to the directory's last data
 * file (starting a new .part-NN file when a partitioned directory is full), composed children into their parent.
 * Prior records whose fields changed (e.g. a status transition) are updated in place, field by field.
 * Files are only rewritten when they change, and keep their trailing-newline style.
 */
export async function appendMetadata(options: AppendMetadataOptions): Promise<AppendMetadataResult> {
  const { domain } = options;
  const maxPartSize = options.maxPartSize ?? 5000;
  const outputDir = path.resolve(options.outputDir);
  const priorDir = path.resolve(options.priorDir);

  if (outputDir !== priorDir) {
    await fs.mkdir(outputDir, { recursive: true });
    if (syncFs.existsSync(priorDir)) {
      await fs.cp(priorDir, outputDir, { recursive: true, force: true });
    }
  }

  const composedChildEntities = computeComposedChildEntities(domain);
  const parentOf = buildParentMap(domain);
  const rootOf = (entityName: string): string => {
    let current = entityName;
    const seen = new Set<string>();
    while (composedChildEntities.has(current) && parentOf.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parentOf.get(current)!.parentEntity;
    }
    return current;
  };

  // 1. Load every root entity directory and index its records (root and nested) by entity + primary key
  const dirs = new Map<string, LoadedDir>();
  const index = new Map<string, IndexedNode>();
  const keepFk = new Set<string>();
  const nodeKey = (entityName: string, pk: string) => `${entityName}\u0000${pk.toLowerCase()}`;

  const indexNode = (
    entityName: string,
    node: SyncMetadataRecord,
    file: LoadedFile
  ): void => {
    const entityCfg = domain.entities[entityName];
    const pk = ExtractPrimaryKey({ ...node.fields, ...node.primaryKey }, entityCfg);
    if (pk !== undefined) {
      index.set(nodeKey(entityName, pk), { node, file });
      if (node.extension) {
        for (const [childName, childCfg] of Object.entries(domain.entities)) {
          if (childCfg.composition?.isA?.parentEntity !== entityName) continue;
          if (node.extension.entity && node.extension.entity !== childCfg.entityName) continue;
          index.set(nodeKey(childName, pk), { node: node.extension, file });
        }
      }
    }
    for (const [colName, colCfg] of Object.entries(entityCfg?.composition?.collections ?? {})) {
      const children = (node.collections?.[colName] ?? []) as SyncMetadataRecord[];
      for (const child of children) {
        if (child.fields && colCfg.foreignKey in child.fields) keepFk.add(`${entityName}.${colName}`);
        indexNode(colCfg.entity, child, file);
      }
    }
    for (const [embedField, embedCfg] of Object.entries(entityCfg?.composition?.embeds ?? {})) {
      const child = node.embeds?.[embedField] as SyncMetadataRecord | undefined;
      if (child && typeof child === 'object' && 'fields' in child) indexNode(embedCfg.entity, child, file);
    }
  };

  for (const [entityName, entityCfg] of Object.entries(domain.entities)) {
    if (composedChildEntities.has(entityName)) continue;
    const dirPath = path.join(outputDir, entityCfg.outputDirectory ?? entityName);
    const loaded: LoadedDir = { dirPath, existed: syncFs.existsSync(dirPath), files: [] };
    if (loaded.existed) {
      const names = (await fs.readdir(dirPath))
        .filter((f) => f.endsWith('.json') && f !== '.mj-sync.json' && f !== '.mj-folder.json')
        .sort();
      for (const name of names) {
        const filePath = path.join(dirPath, name);
        const text = await fs.readFile(filePath, 'utf8');
        const records = JSON.parse(text) as SyncMetadataRecord[];
        const file: LoadedFile = { filePath, records, trailingNewline: text.endsWith('\n'), dirty: false };
        loaded.files.push(file);
        for (const rec of records) indexNode(entityName, rec, file);
      }
    }
    dirs.set(entityName, loaded);
  }

  // 2. Split current records into new records and changed prior records
  const newRows: Record<string, Record<string, unknown>[]> = {};
  const updatedCounts: Record<string, number> = {};
  const appendedCounts: Record<string, number> = {};

  for (const [entityName, currentList] of Object.entries(options.currentRecords)) {
    const entityCfg = domain.entities[entityName];
    if (!entityCfg) continue;
    const priorByPk = new Map<string, Record<string, unknown>>();
    for (const r of options.priorRecords[entityName] ?? []) {
      const pk = ExtractPrimaryKey(r as Record<string, unknown>, entityCfg);
      if (pk !== undefined) priorByPk.set(pk.toLowerCase(), r as Record<string, unknown>);
    }

    const fresh: Record<string, unknown>[] = [];
    let updated = 0;
    for (const row of currentList) {
      const pk = ExtractPrimaryKey(row as Record<string, unknown>, entityCfg);
      if (pk === undefined) {
        throw new Error(`appendMetadata: record in entity '${entityName}' has no primary key`);
      }
      const prior = priorByPk.get(pk.toLowerCase());
      if (!prior) {
        fresh.push(row as Record<string, unknown>);
        continue;
      }
      const changes = changedFields(prior, row as Record<string, unknown>);
      if (changes.length === 0) continue;

      const located = index.get(nodeKey(entityName, pk));
      if (!located) {
        throw new Error(
          `appendMetadata: changed record ${entityName} '${pk}' was not found in '${dirs.get(rootOf(entityName))?.dirPath ?? rootOf(entityName)}'`
        );
      }
      const pkFields = new Set(Object.keys((located.node as SyncMetadataRecord).primaryKey ?? {}));
      for (const field of changes) {
        if (pkFields.has(field)) continue;
        located.node.fields[field] = (row as Record<string, unknown>)[field];
      }
      located.file.dirty = true;
      updated++;
    }
    if (fresh.length > 0) newRows[entityName] = fresh;
    if (updated > 0) updatedCounts[entityName] = updated;
  }

  // 3. Compose new records. New parents carry their new children; new children of prior parents are placed into those parents.
  const { wrapRecord, consumedChildRows } = createRecordComposer(domain, newRows, {
    keepCollectionForeignKey: (parentEntity, colName) => keepFk.has(`${parentEntity}.${colName}`),
  });
  const isConsumed = (entityName: string, row: Record<string, unknown>) => {
    const pk = ExtractPrimaryKey(row, domain.entities[entityName]);
    return pk !== undefined && (consumedChildRows.get(entityName)?.has(pk.toLowerCase()) ?? false);
  };

  const order = computeTopologicalOrder(domain);
  const newRootRecords = new Map<string, SyncMetadataRecord[]>();
  for (const entityName of order) {
    const rows = newRows[entityName];
    if (!rows || composedChildEntities.has(entityName)) continue;
    const entityCfg = domain.entities[entityName]!;
    newRootRecords.set(entityName, rows.map((r) => wrapRecord(r, entityName, entityCfg)));
    appendedCounts[entityName] = rows.length;
  }

  for (const entityName of order) {
    const rows = newRows[entityName];
    if (!rows || !composedChildEntities.has(entityName)) continue;
    const entityCfg = domain.entities[entityName]!;
    const link = parentOf.get(entityName);
    for (const row of rows) {
      if (isConsumed(entityName, row)) continue; // composed by its (new) parent
      if (!link) {
        throw new Error(`appendMetadata: no parent relationship found for composed entity '${entityName}'`);
      }
      const parentPk =
        link.kind === 'isA'
          ? ExtractPrimaryKey(row, entityCfg)
          : link.kind === 'collection'
          ? stringOrUndefined(row[link.foreignKey])
          : undefined;
      const parent = parentPk !== undefined ? index.get(nodeKey(link.parentEntity, parentPk)) : undefined;
      if (!parent) {
        throw new Error(
          `appendMetadata: new ${entityName} '${ExtractPrimaryKey(row, entityCfg)}' has no parent ${link.parentEntity} '${parentPk}' in the prior tree or this cycle`
        );
      }
      const parentNode = parent.node as SyncMetadataRecord;
      if (link.kind === 'isA') {
        const wrapped = wrapRecord(row, entityName, entityCfg);
        parentNode.extension = { entity: entityCfg.entityName, fields: wrapped.fields };
        if (wrapped.collections) parentNode.extension.collections = wrapped.collections;
        if (wrapped.embeds) parentNode.extension.embeds = wrapped.embeds;
      } else if (link.kind === 'collection') {
        const keep = keepFk.has(`${link.parentEntity}.${link.name}`);
        const wrapped = wrapRecord(row, entityName, entityCfg, keep ? undefined : link.foreignKey);
        if (!parentNode.collections) parentNode.collections = {};
        const list = (parentNode.collections[link.name] ?? []) as SyncMetadataRecord[];
        list.push(wrapped);
        parentNode.collections[link.name] = list;
        indexNode(entityName, wrapped, parent.file);
      } else {
        throw new Error(
          `appendMetadata: new embedded ${entityName} under prior ${link.parentEntity} '${parentPk}' is not supported`
        );
      }
      const pk = ExtractPrimaryKey(row, entityCfg);
      if (pk !== undefined) {
        let consumed = consumedChildRows.get(entityName);
        if (!consumed) {
          consumed = new Set<string>();
          consumedChildRows.set(entityName, consumed);
        }
        consumed.add(pk.toLowerCase());
      }
      parent.file.dirty = true;
      appendedCounts[entityName] = (appendedCounts[entityName] ?? 0) + 1;
    }
  }

  // Count children that were composed into new parents
  for (const [entityName, rows] of Object.entries(newRows)) {
    if (!composedChildEntities.has(entityName)) continue;
    const unplaced = rows.filter((r) => !isConsumed(entityName, r));
    if (unplaced.length > 0) {
      throw new Error(`appendMetadata: ${unplaced.length} new ${entityName} record(s) could not be placed under a parent`);
    }
    appendedCounts[entityName] = rows.length;
  }

  // 4. Append new root records to their directories
  const writtenFiles: string[] = [];
  const createdDirs: string[] = [];
  for (const [entityName, wrappedRecords] of newRootRecords) {
    const entityCfg = domain.entities[entityName]!;
    const loaded = dirs.get(entityName)!;
    if (!loaded.existed) {
      await fs.mkdir(loaded.dirPath, { recursive: true });
      const syncConfigPath = path.join(loaded.dirPath, '.mj-sync.json');
      await fs.writeFile(syncConfigPath, JSON.stringify(directorySyncConfig(entityCfg), null, 2) + '\n', 'utf8');
      writtenFiles.push(syncConfigPath);
      createdDirs.push(entityCfg.outputDirectory ?? entityName);
    }
    appendToDirectory(loaded, wrappedRecords, baseFileName(entityName, entityCfg), maxPartSize);
  }

  // 5. Rewrite only the files that changed
  for (const loaded of dirs.values()) {
    for (const file of loaded.files) {
      if (!file.dirty) continue;
      const text = JSON.stringify(file.records, null, 2) + (file.trailingNewline ? '\n' : '');
      await fs.writeFile(file.filePath, text, 'utf8');
      writtenFiles.push(file.filePath);
    }
  }

  // 6. Keep the root .mj-sync.json as committed; only add directories this cycle created
  const rootSyncPath = path.join(outputDir, '.mj-sync.json');
  if (!syncFs.existsSync(rootSyncPath)) {
    const rootSyncConfig = {
      directoryOrder: computeDirectoryOrder(domain, composedChildEntities),
      push: { autoCreateMissingRecords: true },
    };
    await fs.writeFile(rootSyncPath, JSON.stringify(rootSyncConfig, null, 2) + '\n', 'utf8');
    writtenFiles.push(rootSyncPath);
  } else if (createdDirs.length > 0) {
    const text = await fs.readFile(rootSyncPath, 'utf8');
    const rootSync = JSON.parse(text) as { directoryOrder?: string[] };
    const directoryOrder = rootSync.directoryOrder ?? [];
    let changed = false;
    for (const entityName of newRootRecords.keys()) {
      const dir = domain.entities[entityName]!.outputDirectory ?? entityName;
      if (!createdDirs.includes(dir) || directoryOrder.includes(dir)) continue;
      // Insert right after the last directory it depends on (through foreign keys), else at the end
      const dependencyDirs = new Set(
        [...foreignKeyAncestors(domain, entityName)].map((e) => {
          const root = rootOf(e);
          return domain.entities[root]?.outputDirectory ?? root;
        })
      );
      let insertAt = -1;
      directoryOrder.forEach((d, i) => {
        if (dependencyDirs.has(d)) insertAt = i + 1;
      });
      directoryOrder.splice(insertAt < 0 ? directoryOrder.length : insertAt, 0, dir);
      changed = true;
    }
    if (changed) {
      rootSync.directoryOrder = directoryOrder;
      await fs.writeFile(rootSyncPath, JSON.stringify(rootSync, null, 2) + (text.endsWith('\n') ? '\n' : ''), 'utf8');
      writtenFiles.push(rootSyncPath);
    }
  }

  return { writtenFiles, appendedCounts, updatedCounts };
}

type ParentLink =
  | { kind: 'isA'; parentEntity: string }
  | { kind: 'collection'; parentEntity: string; name: string; foreignKey: string }
  | { kind: 'embed'; parentEntity: string; name: string };

/** Maps each composed child entity to the parent it is emitted inside. */
function buildParentMap(domain: DomainConfig): Map<string, ParentLink> {
  const parents = new Map<string, ParentLink>();
  for (const [entityName, entityCfg] of Object.entries(domain.entities)) {
    if (entityCfg.composition?.isA) {
      parents.set(entityName, { kind: 'isA', parentEntity: entityCfg.composition.isA.parentEntity });
    }
    for (const [name, col] of Object.entries(entityCfg.composition?.collections ?? {})) {
      parents.set(col.entity, { kind: 'collection', parentEntity: entityName, name, foreignKey: col.foreignKey });
    }
    for (const [name, emb] of Object.entries(entityCfg.composition?.embeds ?? {})) {
      if (!parents.has(emb.entity)) parents.set(emb.entity, { kind: 'embed', parentEntity: entityName, name });
    }
  }
  return parents;
}

/** Scalar fields whose values differ between a prior row and its current version. */
function changedFields(prior: Record<string, unknown>, current: Record<string, unknown>): string[] {
  const changed: string[] = [];
  for (const [field, val] of Object.entries(current)) {
    if (COMPOSITION_KEYS.has(field)) continue;
    const before = prior[field];
    const different =
      typeof before === 'object' || typeof val === 'object'
        ? JSON.stringify(before) !== JSON.stringify(val)
        : before !== val;
    if (different) changed.push(field);
  }
  return changed;
}

function stringOrUndefined(val: unknown): string | undefined {
  return val === undefined || val === null || val === '' ? undefined : String(val);
}

function directorySyncConfig(entityCfg: EntityConfig): Record<string, unknown> {
  const syncConfig: Record<string, unknown> = { entity: entityCfg.entityName };
  const collections = entityCfg.composition?.collections ?? {};
  if (Object.keys(collections).length > 0) {
    syncConfig['collections'] = Object.fromEntries(
      Object.entries(collections).map(([name, col]) => [name, { mode: col.mode ?? 'upsert' }])
    );
  }
  return syncConfig;
}

function baseFileName(entityName: string, entityCfg: EntityConfig): string {
  if (entityCfg.outputFileName) {
    return entityCfg.outputFileName.endsWith('.json') ? entityCfg.outputFileName.slice(0, -5) : entityCfg.outputFileName;
  }
  return entityCfg.outputDirectory ? `.${entityCfg.outputDirectory}` : entityName;
}

const PART_FILE = /\.part-(\d+)\.json$/;

/**
 * Appends records to a directory's data files. A partitioned directory fills its last part up to maxPartSize
 * and then starts new parts; a single-file directory grows in place (never re-partitioned, so no file renames).
 */
function appendToDirectory(loaded: LoadedDir, records: SyncMetadataRecord[], base: string, maxPartSize: number): void {
  if (records.length === 0) return;
  const last = loaded.files.at(-1);

  if (!last) {
    if (records.length <= maxPartSize) {
      loaded.files.push({ filePath: path.join(loaded.dirPath, `${base}.json`), records, trailingNewline: true, dirty: true });
      return;
    }
    for (let p = 0; p * maxPartSize < records.length; p++) {
      const name = `${base}.part-${String(p + 1).padStart(2, '0')}.json`;
      const slice = records.slice(p * maxPartSize, (p + 1) * maxPartSize);
      loaded.files.push({ filePath: path.join(loaded.dirPath, name), records: slice, trailingNewline: true, dirty: true });
    }
    return;
  }

  const partMatch = path.basename(last.filePath).match(PART_FILE);
  if (!partMatch) {
    last.records.push(...records);
    last.dirty = true;
    return;
  }

  let remaining = records;
  const room = Math.max(0, maxPartSize - last.records.length);
  if (room > 0) {
    last.records.push(...remaining.slice(0, room));
    last.dirty = true;
    remaining = remaining.slice(room);
  }
  let partNo = parseInt(partMatch[1]!, 10);
  const prefix = path.basename(last.filePath).replace(PART_FILE, '');
  while (remaining.length > 0) {
    partNo++;
    const name = `${prefix}.part-${String(partNo).padStart(2, '0')}.json`;
    loaded.files.push({
      filePath: path.join(loaded.dirPath, name),
      records: remaining.slice(0, maxPartSize),
      trailingNewline: last.trailingNewline,
      dirty: true,
    });
    remaining = remaining.slice(maxPartSize);
  }
}

/** Every entity reachable from `entityName` by following foreign keys (its transitive parents). */
function foreignKeyAncestors(domain: DomainConfig, entityName: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entityName];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const fk of Object.values(domain.entities[cur]?.foreignKeys ?? {})) {
      if (fk.targetEntity === entityName || seen.has(fk.targetEntity) || !domain.entities[fk.targetEntity]) continue;
      seen.add(fk.targetEntity);
      stack.push(fk.targetEntity);
    }
  }
  return seen;
}
