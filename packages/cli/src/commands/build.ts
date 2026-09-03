import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadProject } from '../project.js';
import {
  CausalGraphResolver,
  IdentityService,
  createRng,
  emitMetadata,
  emitSkywayMigration,
  HeroInjector,
  MotifSampler,
  StateLadderEngine,
  FactorEngine,
  RetrospectiveUnroller,
  type SimulationNode,
  type EntityCandidate,
} from '@memberjunction/loom-engine';
import type { SimulationCheckpoint } from '@memberjunction/loom-contracts';
import { generateEntityRecord } from '../generation.js';

export interface BuildCommandOptions {
  project: string;
  seed?: string;
  release?: string;
  output?: string;
  migrationsOutput?: string;
}

export async function executeBuild(options: BuildCommandOptions): Promise<void> {
  const loaded = await loadProject(options.project);
  const seed = options.seed ? parseInt(options.seed, 10) : 42;
  const releaseDate =
    options.release ??
    ((loaded.manifest as Record<string, unknown>).releaseDate as string) ??
    ((loaded.manifest as Record<string, unknown>).asOfDate as string) ??
    '2026-09-02';
  const asOfYear = parseInt(releaseDate.slice(0, 4), 10) || 2026;
  const outputDir = options.output
    ? path.resolve(process.cwd(), options.output)
    : path.resolve(loaded.projectDir, loaded.manifest.output.metadataDir);
  const migrationsDir = options.migrationsOutput
    ? path.resolve(process.cwd(), options.migrationsOutput)
    : path.resolve(loaded.projectDir, loaded.manifest.output.migrationsDir);

  console.log(`🧵 Loom Build: Generating domain '${loaded.domain.name}'`);
  console.log(`   Seed: ${seed} | Release: ${releaseDate} (asOfYear: ${asOfYear})`);
  console.log(`   Entities: ${Object.keys(loaded.domain.entities).join(', ')}`);

  const identityService = new IdentityService();
  identityService.RegisterNamespace(loaded.domain.name, loaded.domain.namespace);

  const heroInjector = new HeroInjector(
    loaded.domain.name,
    loaded.domain.namespace,
    loaded.heroesManifest?.heroes ?? []
  );
  const motifSampler = new MotifSampler(loaded.motifsManifest?.motifs ?? []);
  const ladderEngine = new StateLadderEngine(loaded.laddersManifest?.ladders ?? []);
  const factorEngine = new FactorEngine();

  // Collect all factor contracts from ruleset modules
  const factorContracts = Object.values(loaded.rulesetModules).flatMap((mod) =>
    Object.values(mod.effects)
  );

  const resolver = new CausalGraphResolver();
  const unrollerMap = new Map<string, RetrospectiveUnroller>();

  // Create simulation DAG nodes for each entity defined in domain.json
  for (const [entityName, entityCfg] of Object.entries(loaded.domain.entities)) {
    const node: SimulationNode = {
      id: `node-${entityName.toLowerCase()}`,
      consumes: Object.values(entityCfg.foreignKeys).map((fk) => fk.targetEntity),
      produces: [entityName],
      description: `Generates ${entityName} records with causal factor calibration`,
      execute: async (ctx) => {
        const rng = createRng(ctx.seed, `entity:${entityName}`);

        // Read authored volume from ruleset params, falling back to default 10
        let targetCount = 10;
        for (const mod of Object.values(loaded.rulesetModules)) {
          const directVol = mod.params[`volume_${entityName}`];
          const lowerVol = mod.params[`volume_${entityName.toLowerCase()}`];
          if (typeof directVol === 'number') {
            targetCount = directVol;
            break;
          }
          if (typeof lowerVol === 'number') {
            targetCount = lowerVol;
            break;
          }
        }

        const parentPool: Record<string, Record<string, unknown>[]> = {};
        for (const [pEnt, pRows] of ctx.generatedData.entries()) {
          parentPool[pEnt] = pRows;
        }

        const records: Record<string, unknown>[] = [];

        // 1. Inject heroes for this entity
        const entityHeroes = (loaded.heroesManifest?.heroes ?? []).filter((h) => h.entity === entityName);
        for (const hero of entityHeroes) {
          const heroRec = heroInjector.GetHero(hero.heroKey);
          if (heroRec) {
            records.push({
              ID: heroRec.id,
              ...hero.businessKeys,
              ...hero.fixedFields,
            });
          }
        }

        // 2. Generate remaining background entities up to targetCount
        const needed = Math.max(0, targetCount - records.length);
        for (let i = 1; i <= needed; i++) {
          const row = generateEntityRecord({
            domain: loaded.domain,
            entity: entityName,
            i: records.length + 1,
            parentPool,
            rng,
            identityService,
          });
          records.push(row);
        }

        // 3. Multi-cycle retrospective simulation for entities subject to factors or heroes
        const startCycle =
          typeof (loaded.manifest as Record<string, unknown>).startCycle === 'number'
            ? ((loaded.manifest as Record<string, unknown>).startCycle as number)
            : asOfYear - 4;
        const cycles: number[] = [];
        for (let y = startCycle; y <= asOfYear; y++) {
          cycles.push(y);
        }

        const unrollCandidates: EntityCandidate[] = records.map((r, idx) => {
          const id = String(r['ID'] ?? r['id']);
          const hero = heroInjector.GetHeroById(id);
          return {
            id,
            entity: entityName,
            birthCycle: hero?.birthCycle ?? (asOfYear - (idx % 4)),
            latentDials: hero ? { ...hero.latentDials } : { theta: 0.0, phi: 0.0 },
            fixedFields: hero ? { ...hero.fixedFields } : {},
            isHero: hero !== undefined,
            heroKey: hero?.heroKey,
          };
        });

        const unroller = new RetrospectiveUnroller({
          cycles,
          entities: unrollCandidates,
          heroInjector,
          motifSampler,
          ladderEngine,
          factorEngine,
          factorContracts: factorContracts.filter((f) => f.effect === entityName),
          eras: loaded.erasManifest?.eras ?? [],
        });

        unroller.Initialize(rng);
        unroller.Run(rng);
        unrollerMap.set(entityName, unroller);

        // 4. Calibrate entity record fields against factor outcomes (domain-agnostic)
        const entityFactors = factorContracts.filter((f) => f.effect === entityName);
        for (const row of records) {
          const id = String(row['ID'] ?? row['id']);
          const state = unroller.GetEntityState(id);
          if (state) {
            const outcomes = state.outcomesByCycle.get(asOfYear);
            for (const contract of entityFactors) {
              const realized = outcomes ? outcomes[contract.id] : undefined;
              if (realized !== undefined && contract.outcome && contract.outcome.where) {
                const otherwise = (contract.outcome as Record<string, unknown>).otherwise as Record<string, unknown> | undefined;
                const hero = heroInjector.GetHeroById(id);
                for (const [field, targetVal] of Object.entries(contract.outcome.where)) {
                  if (hero && hero.fixedFields && field in hero.fixedFields) {
                    // Invariant: hero fixedFields take precedence over factor outcome calibration
                    continue;
                  }
                  if (realized) {
                    row[field] = targetVal;
                  } else {
                    if (typeof targetVal === 'boolean') {
                      row[field] = !targetVal;
                    } else if (otherwise && otherwise[field] !== undefined) {
                      row[field] = otherwise[field];
                    } else if (row[field] !== targetVal) {
                      // Row already has an alternative non-target value from base generation; keep it
                    } else {
                      throw new Error(
                        `Factor '${contract.id}': negative outcome for field '${entityName}.${field}' cannot be resolved. Specify an explicit 'otherwise' clause in the factor outcome.`
                      );
                    }
                  }
                }
              }
            }
          }
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

  // Write initial simulation checkpoint.json with populated continuity
  const totalRecordCounts: Record<string, number> = {};
  const activeEntityIds: Record<string, string[]> = {};
  const latentStates: Record<string, Record<string, number>> = {};
  const activeLifecycleStates: Record<string, Array<Record<string, unknown>>> = {};

  for (const [e, rows] of Object.entries(allRecords)) {
    totalRecordCounts[e] = rows.length;
    activeEntityIds[e] = rows.map((r) => String(r['ID'] ?? r['id']));

    const unroller = unrollerMap.get(e);
    for (const r of rows) {
      const id = String(r['ID'] ?? r['id']);
      const state = unroller?.GetEntityState(id);
      if (state) {
        latentStates[id] = { ...state.latentDials };
      }
    }
  }

  for (const ladder of loaded.laddersManifest?.ladders ?? []) {
    for (const id of activeEntityIds[ladder.entity] ?? []) {
      const state = ladderEngine.GetEntityState(ladder.ladderKey, id);
      if (state) {
        if (!activeLifecycleStates[id]) activeLifecycleStates[id] = [];
        activeLifecycleStates[id].push({
          ladder: ladder.ladderKey,
          currentState: state.currentState,
          enteredCycle: state.enteredCycle,
          tenure: state.tenureInCurrentState,
        });
      }
    }
  }

  const initialCheckpoint: SimulationCheckpoint = {
    domain: loaded.domain.name,
    seed,
    releaseDate,
    cycleIndex: 0,
    continuity: {
      asOfDate: releaseDate,
      cycleIndex: 0,
      activeEntityIds,
      latentStates,
      activeLifecycleStates,
      metadata: { initializedAt: releaseDate },
    },
    committedRecordCounts: totalRecordCounts,
  };

  await fs.writeFile(
    path.join(outputDir, 'checkpoint.json'),
    JSON.stringify(initialCheckpoint, null, 2),
    'utf8'
  );
  console.log(`   ✓ Saved initial checkpoint with populated continuity to ${path.join(outputDir, 'checkpoint.json')}`);
  console.log(`✨ Build complete successfully.`);
}
