import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadProject } from '../project.js';
import {
  CausalGraphResolver,
  IdentityService,
  createRng,
  emitMetadata,
  emitSkywayMigration,
  type SimulationNode,
  type RngStream,
} from '@memberjunction/loom-engine';
import type { SimulationCheckpoint, EntityConfig } from '@memberjunction/loom-contracts';

export interface BuildCommandOptions {
  project: string;
  seed?: string;
  release?: string;
  output?: string;
}

export async function executeBuild(options: BuildCommandOptions): Promise<void> {
  const loaded = await loadProject(options.project);
  const seed = options.seed ? parseInt(options.seed, 10) : 42;
  const releaseDate = options.release ?? '2026-09-02';
  const outputDir = options.output
    ? path.resolve(process.cwd(), options.output)
    : path.resolve(loaded.projectDir, loaded.manifest.output.metadataDir);
  const migrationsDir = path.resolve(loaded.projectDir, loaded.manifest.output.migrationsDir);

  console.log(`🧵 Loom Build: Generating domain '${loaded.domain.name}'`);
  console.log(`   Seed: ${seed} | Release: ${releaseDate}`);
  console.log(`   Entities: ${Object.keys(loaded.domain.entities).join(', ')}`);

  const identityService = new IdentityService();
  identityService.RegisterNamespace(loaded.domain.name, loaded.domain.namespace);

  const resolver = new CausalGraphResolver();

  // Create a default simulation node for each entity defined in domain.json
  for (const [entityName, entityCfg] of Object.entries(loaded.domain.entities)) {
    const node: SimulationNode = {
      id: `node-${entityName.toLowerCase()}`,
      consumes: Object.values(entityCfg.foreignKeys).map((fk) => fk.targetEntity),
      produces: [entityName],
      description: `Generates ${entityName} records`,
      execute: async (ctx) => {
        const rng = createRng(ctx.seed, `entity:${entityName}`);
        const count = 10;
        const records: Record<string, unknown>[] = [];

        for (let i = 1; i <= count; i++) {
          const bizKey = `${entityName}-${i}`;
          const id = identityService.MintId(loaded.domain.name, entityName, bizKey);
          const row = generateEntityRecord(
            entityCfg,
            id,
            i,
            releaseDate,
            rng,
            (parentEntity) => {
              const parentList = ctx.generatedData.get(parentEntity) ?? [];
              return parentList.length > 0 ? rng.pick(parentList) : undefined;
            }
          );

          records.push(row);
        }

        return { [entityName]: records };
      },
    };

    resolver.RegisterNode(node);
  }

  const executionOrder = resolver.ResolveOrder();
  console.log(`   Execution DAG: ${executionOrder.map((n) => n.id).join(' -> ')}`);

  const generatedData = new Map<string, Record<string, unknown>[]>();
  const allRecords: Record<string, Record<string, unknown>[]> = {};

  for (const node of executionOrder) {
    const result = await node.execute({
      domain: loaded.domain,
      seed,
      asOfDate: releaseDate,
      generatedData,
    });
    for (const [entity, rows] of Object.entries(result)) {
      generatedData.set(entity, rows);
      allRecords[entity] = rows;
    }
  }

  // Emit metadata tree
  const writtenMetadata = await emitMetadata({
    outputDir,
    domain: loaded.domain,
    data: allRecords,
  });
  console.log(`   ✓ Emitted ${writtenMetadata.length} metadata files to ${outputDir}`);

  // Emit baseline Skyway migration with timestamp version
  const migrationVersion = `${releaseDate.replace(/-/g, '')}0000`;
  const migrationPath = await emitSkywayMigration({
    outputDir: migrationsDir,
    version: migrationVersion,
    description: `Baseline_${loaded.domain.name}`,
    domain: loaded.domain,
    data: allRecords,
  });
  console.log(`   ✓ Emitted Skyway migration: ${path.basename(migrationPath)}`);

  // Write initial simulation checkpoint.json
  const totalRecordCounts: Record<string, number> = {};
  for (const [e, rows] of Object.entries(allRecords)) {
    totalRecordCounts[e] = rows.length;
  }

  const initialCheckpoint: SimulationCheckpoint = {
    domain: loaded.domain.name,
    seed,
    releaseDate,
    cycleIndex: 0,
    continuity: {
      asOfDate: releaseDate,
      cycleIndex: 0,
      activeEntityIds: {},
      latentStates: {},
      activeLifecycleStates: {},
      metadata: { initializedAt: releaseDate },
    },
    committedRecordCounts: totalRecordCounts,
  };

  await fs.writeFile(
    path.join(outputDir, 'checkpoint.json'),
    JSON.stringify(initialCheckpoint, null, 2),
    'utf8'
  );
  console.log(`   ✓ Saved initial checkpoint to ${path.join(outputDir, 'checkpoint.json')}`);
  console.log(`✨ Build complete successfully.`);
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
