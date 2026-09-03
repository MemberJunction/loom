import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadProject } from '../project.js';
import {
  Accumulator,
  IdentityService,
  createRng,
  emitMetadata,
  emitSkywayMigration,
  type RngStream,
} from '@memberjunction/loom-engine';
import {
  SimulationCheckpointSchema,
  type SimulationCheckpoint,
  type EntityConfig,
} from '@memberjunction/loom-contracts';

export interface AccumulateCommandOptions {
  project: string;
  priorState: string;
  weeks?: string;
  seed?: string;
  asOf?: string;
  output?: string;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT';
}

export async function executeAccumulate(options: AccumulateCommandOptions): Promise<void> {
  const loaded = await loadProject(options.project);
  const weeks = options.weeks ? parseInt(options.weeks, 10) : 1;
  const seed = options.seed ? parseInt(options.seed, 10) : 42;
  const priorDir = path.resolve(process.cwd(), options.priorState);
  const outputDir = options.output
    ? path.resolve(process.cwd(), options.output)
    : path.resolve(loaded.projectDir, loaded.manifest.output.metadataDir);
  const migrationsDir = path.resolve(loaded.projectDir, loaded.manifest.output.migrationsDir);

  // 1. Read prior checkpoint if available
  let priorCheckpoint: SimulationCheckpoint | null = null;
  const checkpointPath = path.join(priorDir, 'checkpoint.json');
  try {
    const raw = await fs.readFile(checkpointPath, 'utf8');
    priorCheckpoint = SimulationCheckpointSchema.parse(JSON.parse(raw));
  } catch (err) {
    if (!isEnoent(err)) {
      throw new Error(`Failed to parse checkpoint at '${checkpointPath}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Compute deterministic cycle index and asOfDate
  const cycleIndex = (priorCheckpoint?.cycleIndex ?? 0) + 1;
  let asOfDate: string;
  if (options.asOf) {
    asOfDate = options.asOf;
  } else if (priorCheckpoint?.continuity.asOfDate) {
    const priorD = new Date(priorCheckpoint.continuity.asOfDate);
    priorD.setUTCDate(priorD.getUTCDate() + weeks * 7);
    asOfDate = priorD.toISOString().slice(0, 10);
  } else {
    asOfDate = '2026-09-02';
  }

  console.log(`🧵 Loom Accumulate: Advancing simulation for '${loaded.domain.name}'`);
  console.log(`   Cycle: ${cycleIndex} (+${weeks} week(s)) | As-Of: ${asOfDate} | Seed: ${seed}`);
  console.log(`   Prior State: ${priorDir}`);

  // 3. Read prior state records from disk
  const priorRecords: Record<string, Record<string, unknown>[]> = {};
  for (const [entityName, entityCfg] of Object.entries(loaded.domain.entities)) {
    const filePath = path.join(priorDir, entityCfg.pack, `${entityName}.json`);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (jsonErr) {
        throw new Error(`Invalid JSON in metadata file '${filePath}': ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error(`Metadata file '${filePath}' must contain an array of records`);
      }
      priorRecords[entityName] = parsed as Record<string, unknown>[];
    } catch (err) {
      if (!isEnoent(err)) {
        throw err;
      }
      priorRecords[entityName] = [];
    }
  }

  // Check seed continuity
  if (priorCheckpoint && options.seed && parseInt(options.seed, 10) !== priorCheckpoint.seed) {
    console.warn(`   ⚠️ Warning: seed ${options.seed} differs from checkpoint seed ${priorCheckpoint.seed}; maintaining checkpoint continuity`);
  }

  // 4. Generate simulated delta additions strictly conforming to domain fields
  const identityService = new IdentityService();
  identityService.RegisterNamespace(loaded.domain.name, loaded.domain.namespace);

  const currentRecords: Record<string, Record<string, unknown>[]> = {};

  for (const [entityName, existingList] of Object.entries(priorRecords)) {
    const list = [...existingList];
    const entityCfg = loaded.domain.entities[entityName];
    if (!entityCfg) continue;

    const newItemsCount = 2;
    const startIdx = list.length + 1;
    const rng = createRng(seed, `accumulate:${entityName}:cycle:${cycleIndex}`);

    for (let i = startIdx; i < startIdx + newItemsCount; i++) {
      const bizKey = `${entityName}-${i}`;
      const id = identityService.MintId(loaded.domain.name, entityName, bizKey);
      const row = generateEntityRecord(
        entityCfg,
        id,
        i,
        asOfDate,
        rng,
        (parentEntity) => {
          const parentList = currentRecords[parentEntity] ?? priorRecords[parentEntity] ?? [];
          return parentList.length > 0 ? rng.pick(parentList) : undefined;
        }
      );
      list.push(row);
    }
    currentRecords[entityName] = list;
  }

  // 5. Compute pure delta using Accumulator (enforces no deletions by default)
  const accumulator = new Accumulator();
  const diff = accumulator.ComputeDelta(
    loaded.domain,
    cycleIndex,
    asOfDate,
    priorRecords,
    currentRecords
  );

  console.log(`   Delta Summary:`);
  for (const [entity, count] of Object.entries(diff.newRecordCounts)) {
    console.log(`     • ${entity}: +${count} new record(s)`);
  }

  // 6. Update metadata tree
  await emitMetadata({
    outputDir,
    domain: loaded.domain,
    data: currentRecords,
  });

  // 7. Emit additive Skyway migration with sortable timestamp version
  const migrationVersion = `${asOfDate.replace(/-/g, '')}${String(cycleIndex).padStart(4, '0')}`;
  const migrationPath = await emitSkywayMigration({
    outputDir: migrationsDir,
    version: migrationVersion,
    description: `Delta_Cycle_${cycleIndex}_${loaded.domain.name}`,
    domain: loaded.domain,
    data: diff.delta.generatedRecords,
  });

  // 8. Write updated checkpoint.json
  const totalRecordCounts: Record<string, number> = {};
  for (const [e, rows] of Object.entries(currentRecords)) {
    totalRecordCounts[e] = rows.length;
  }

  const updatedCheckpoint: SimulationCheckpoint = {
    domain: loaded.domain.name,
    seed,
    releaseDate: asOfDate,
    cycleIndex,
    continuity: {
      asOfDate,
      cycleIndex,
      activeEntityIds: {},
      latentStates: {},
      activeLifecycleStates: {},
      metadata: { lastAccumulatedAt: asOfDate },
    },
    committedRecordCounts: totalRecordCounts,
    lastGeneratedDelta: diff.delta,
  };

  await fs.writeFile(
    path.join(outputDir, 'checkpoint.json'),
    JSON.stringify(updatedCheckpoint, null, 2),
    'utf8'
  );

  console.log(`   ✓ Emitted additive migration: ${path.basename(migrationPath)}`);
  console.log(`   ✓ Saved checkpoint to: ${path.join(outputDir, 'checkpoint.json')}`);
  console.log(`✨ Accumulation complete.`);
}

/**
 * Dynamically synthesizes a record conforming strictly to declared domain fields.
 * Never emits fields not declared in entityCfg.fields.
 */
function generateEntityRecord(
  entityCfg: EntityConfig,
  id: string,
  i: number,
  asOfDate: string,
  rng: RngStream,
  parentLookup: (parentEntity: string) => Record<string, unknown> | undefined
): Record<string, unknown> {
  const row: Record<string, unknown> = { ID: id };

  for (const [fieldName, fieldCfg] of Object.entries(entityCfg.fields)) {
    if (fieldCfg.isPrimaryKey || fieldName === 'ID' || fieldName === 'id') {
      continue;
    }

    // Foreign key lookup
    const fk = Object.values(entityCfg.foreignKeys).find((f) => f.fieldName === fieldName);
    if (fk) {
      const parent = parentLookup(fk.targetEntity);
      if (parent) {
        row[fieldName] = parent[fk.targetField] ?? parent['ID'] ?? parent['id'];
        continue;
      }
    }

    // Dynamic field mapping based on semantic domain names
    if (fieldName === 'Status') {
      row[fieldName] = i % 5 !== 0 ? 'Active' : 'Lapsed';
    } else if (fieldName === 'Tier') {
      row[fieldName] = (i % 10 === 1 || i % 10 === 4 || i % 10 === 7) ? 'Enterprise' : (i % 2 === 0 ? 'MidMarket' : 'SMB');
    } else if (fieldName === 'AutoRenew') {
      row[fieldName] = (i % 10 !== 4 && i % 10 !== 8 && i % 10 !== 0);
    } else if (fieldName === 'Quantity') {
      row[fieldName] = rng.int(1, 4);
    } else if (fieldName.includes('Fee') || fieldName.includes('Price') || fieldName.includes('Amount')) {
      row[fieldName] = rng.int(50, 500);
    } else if (fieldName === 'Employees') {
      row[fieldName] = rng.int(50, 1500);
    } else if (fieldName === 'AnnualRevenue') {
      row[fieldName] = rng.int(2000000, 50000000);
    } else if (fieldCfg.type === 'number') {
      row[fieldName] = rng.int(10, 100);
    } else if (fieldCfg.type === 'boolean') {
      row[fieldName] = true;
    } else if (fieldCfg.type === 'date') {
      row[fieldName] = asOfDate;
    } else if (fieldCfg.type === 'uuid') {
      row[fieldName] = id;
    } else {
      // String fields
      if (fieldName === 'Name') row[fieldName] = `${entityCfg.name} ${i}`;
      else if (fieldName === 'SKU') row[fieldName] = `SKU-${String(i).padStart(4, '0')}`;
      else if (fieldName === 'Email') row[fieldName] = `user${i}@example.com`;
      else if (fieldName === 'OrderNumber') row[fieldName] = `ORD-${asOfDate.slice(0, 4)}-${String(i).padStart(4, '0')}`;
      else if (fieldName === 'PaymentMethod') row[fieldName] = i % 2 === 0 ? 'CreditCard' : 'ACH';
      else row[fieldName] = `${fieldName}_${i}`;
    }
  }

  return row;
}
