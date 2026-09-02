import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadProject } from '../project.js';
import {
  Accumulator,
  IdentityService,
  emitMetadata,
  emitSkywayMigration,
} from '@memberjunction/loom-engine';

export interface AccumulateCommandOptions {
  project: string;
  priorState: string;
  weeks?: string;
  seed?: string;
  output?: string;
}

export async function executeAccumulate(options: AccumulateCommandOptions): Promise<void> {
  const loaded = await loadProject(options.project);
  const weeks = options.weeks ? parseInt(options.weeks, 10) : 1;
  const asOfDate = new Date().toISOString().slice(0, 10);
  const priorDir = path.resolve(process.cwd(), options.priorState);
  const outputDir = options.output
    ? path.resolve(process.cwd(), options.output)
    : path.resolve(loaded.projectDir, loaded.manifest.output.metadataDir);
  const migrationsDir = path.resolve(loaded.projectDir, loaded.manifest.output.migrationsDir);

  console.log(`🧵 Loom Accumulate: Advancing simulation for '${loaded.domain.name}'`);
  console.log(`   Advancing: +${weeks} week(s) | Prior State: ${priorDir}`);

  // 1. Read prior state records from disk
  const priorRecords: Record<string, Record<string, unknown>[]> = {};
  for (const [entityName, entityCfg] of Object.entries(loaded.domain.entities)) {
    const filePath = path.join(priorDir, entityCfg.pack, `${entityName}.json`);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      priorRecords[entityName] = JSON.parse(content);
    } catch {
      priorRecords[entityName] = [];
    }
  }

  // 2. Generate simulated delta additions
  const identityService = new IdentityService();
  identityService.registerNamespace(loaded.domain.name, loaded.domain.namespace);

  const currentRecords: Record<string, Record<string, unknown>[]> = {};

  for (const [entityName, existingList] of Object.entries(priorRecords)) {
    const list = [...existingList];
    // Add 2 new records per entity to represent the weekly delta advance
    const startIdx = list.length + 1;
    for (let i = startIdx; i <= startIdx + 1; i++) {
      const bizKey = `${entityName}-${i}`;
      const id = identityService.mintId(loaded.domain.name, entityName, bizKey);
      list.push({
        ID: id,
        Name: `${entityName} ${i} (Week ${weeks})`,
        CreatedAt: asOfDate,
      });
    }
    currentRecords[entityName] = list;
  }

  // 3. Compute pure delta using Accumulator
  const accumulator = new Accumulator();
  const diff = accumulator.computeDelta(
    loaded.domain,
    weeks,
    asOfDate,
    priorRecords,
    currentRecords
  );

  console.log(`   Delta Summary:`);
  for (const [entity, count] of Object.entries(diff.newRecordCounts)) {
    console.log(`     • ${entity}: +${count} new record(s)`);
  }

  // 4. Update metadata tree
  await emitMetadata({
    outputDir,
    domain: loaded.domain,
    data: currentRecords,
  });

  // 5. Emit additive Skyway migration for new delta records only
  const migrationPath = await emitSkywayMigration({
    outputDir: migrationsDir,
    version: `${Date.now()}`,
    description: `Delta_Week_${weeks}_${loaded.domain.name}`,
    domain: loaded.domain,
    data: diff.delta.generatedRecords,
  });

  console.log(`   ✓ Emitted additive migration: ${path.basename(migrationPath)}`);
  console.log(`✨ Accumulation complete.`);
}
