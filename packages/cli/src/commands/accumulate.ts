import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadProject } from '../project.js';
import {
  Accumulator,
  IdentityService,
  emitMetadata,
  emitSkywayMigration,
  createRng,
} from '@memberjunction/loom-engine';
import {
  SimulationCheckpointSchema,
  type SimulationCheckpoint,
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
    // Advance prior date by weeks * 7 days
    const priorD = new Date(priorCheckpoint.continuity.asOfDate);
    priorD.setUTCDate(priorD.getUTCDate() + weeks * 7);
    asOfDate = priorD.toISOString().slice(0, 10);
  } else {
    asOfDate = '2026-09-02'; // Stable deterministic baseline
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

  // 4. Generate simulated delta additions using the specified seed
  const identityService = new IdentityService();
  identityService.registerNamespace(loaded.domain.name, loaded.domain.namespace);
  const rng = createRng(seed, `accumulate:cycle:${cycleIndex}`);

  const currentRecords: Record<string, Record<string, unknown>[]> = {};

  for (const [entityName, existingList] of Object.entries(priorRecords)) {
    const list = [...existingList];
    const newItemsCount = 2; // Fixed delta per cycle for testing
    const startIdx = list.length + 1;

    for (let i = startIdx; i < startIdx + newItemsCount; i++) {
      const bizKey = `${entityName}-${i}`;
      const id = identityService.mintId(loaded.domain.name, entityName, bizKey);
      list.push({
        ID: id,
        Name: `${entityName} ${i} (Cycle ${cycleIndex})`,
        CreatedAt: asOfDate,
        RollValue: rng.int(10, 100),
      });
    }
    currentRecords[entityName] = list;
  }

  // 5. Compute pure delta using Accumulator
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

  // 7. Emit additive Skyway migration for new delta records with deterministic version
  const migrationVersion = `${String(cycleIndex).padStart(4, '0')}_${asOfDate.replace(/-/g, '')}`;
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
