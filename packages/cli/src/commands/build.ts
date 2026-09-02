import * as path from 'node:path';
import { loadProject } from '../project.js';
import {
  CausalGraphResolver,
  IdentityService,
  emitMetadata,
  emitSkywayMigration,
  type SimulationNode,
  createRng,
} from '@memberjunction/loom-engine';

export interface BuildCommandOptions {
  project: string;
  seed?: string;
  release?: string;
  output?: string;
}

export async function executeBuild(options: BuildCommandOptions): Promise<void> {
  const loaded = await loadProject(options.project);
  const seed = options.seed ? parseInt(options.seed, 10) : 42;
  const releaseDate = options.release ?? new Date().toISOString().slice(0, 10);
  const outputDir = options.output
    ? path.resolve(process.cwd(), options.output)
    : path.resolve(loaded.projectDir, loaded.manifest.output.metadataDir);
  const migrationsDir = path.resolve(loaded.projectDir, loaded.manifest.output.migrationsDir);

  console.log(`🧵 Loom Build: Generating domain '${loaded.domain.name}'`);
  console.log(`   Seed: ${seed} | Release: ${releaseDate}`);
  console.log(`   Entities: ${Object.keys(loaded.domain.entities).join(', ')}`);

  const identityService = new IdentityService();
  identityService.registerNamespace(loaded.domain.name, loaded.domain.namespace);

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
        const count = 10; // Default baseline test batch
        const records: Record<string, unknown>[] = [];

        for (let i = 1; i <= count; i++) {
          const bizKey = `${entityName}-${i}`;
          const id = identityService.mintId(loaded.domain.name, entityName, bizKey);
          const row: Record<string, unknown> = {
            ID: id,
            Name: `${entityName} ${i}`,
            CreatedAt: releaseDate,
          };

          // Link foreign keys to parents if available
          for (const fk of Object.values(entityCfg.foreignKeys)) {
            const parentList = ctx.generatedData.get(fk.targetEntity) ?? [];
            if (parentList.length > 0) {
              const parent = rng.pick(parentList);
              row[fk.fieldName] = parent[fk.targetField] ?? parent['ID'];
            }
          }

          records.push(row);
        }

        return { [entityName]: records };
      },
    };
    resolver.registerNode(node);
  }

  const executionOrder = resolver.resolveOrder();
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

  // Emit baseline Skyway migration
  const migrationVersion = `0000_${releaseDate.replace(/-/g, '')}`;
  const migrationPath = await emitSkywayMigration({
    outputDir: migrationsDir,
    version: migrationVersion,
    description: `Baseline_${loaded.domain.name}`,
    domain: loaded.domain,
    data: allRecords,
  });
  console.log(`   ✓ Emitted Skyway migration: ${path.basename(migrationPath)}`);
  console.log(`✨ Build complete successfully.`);
}
