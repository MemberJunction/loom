import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadProject } from '../project.js';
import {
  CausalGraphResolver,
  IdentityService,
  createRng,
  emitMetadata,
  HeroInjector,
  MotifSampler,
  StateLadderEngine,
  FactorEngine,
  RetrospectiveUnroller,
  type SimulationNode,
  type EntityCandidate,
} from '@memberjunction/loom-engine';
import type { SimulationCheckpoint, HeroOutcomePin } from '@memberjunction/loom-contracts';
import { generateEntityRecord } from '../generation.js';

export interface BuildCommandOptions {
  project: string;
  seed?: string;
  release?: string;
  output?: string;
}

export async function executeBuild(options: BuildCommandOptions): Promise<void> {
  const loaded = await loadProject(options.project);
  const seed = options.seed ? parseInt(options.seed, 10) : 42;
  const releaseDate = options.release ?? loaded.manifest.releaseDate ?? '2026-09-02';
  const asOfYear = parseInt(releaseDate.slice(0, 4), 10) || 2026;
  const outputDir = options.output
    ? path.resolve(process.cwd(), options.output)
    : path.resolve(loaded.projectDir, loaded.manifest.output.metadataDir);

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

  // Create simulation DAG nodes for each entity defined in domain.json
  const bgRecordsByEntity = new Map<string, Record<string, unknown>[]>();

  for (const [entityName, entityCfg] of Object.entries(loaded.domain.entities)) {
    const node: SimulationNode = {
      id: `node-${entityName.toLowerCase()}`,
      consumes: Object.values(entityCfg.foreignKeys).map((fk) => fk.targetEntity),
      produces: [entityName],
      description: `Generates ${entityName} records with causal factor calibration`,
      execute: async (ctx) => {
        // Read authored volume from ruleset params, falling back to default 10
        let targetCount = 10;
        for (const mod of Object.values(loaded.rulesetModules)) {
          const directVol = mod.params[`volume_${entityName}`];
          const lowerVol = mod.params[`volume_${entityName.toLowerCase()}`];
          if (typeof directVol === 'number') {
            targetCount = directVol;
            break;
          } else if (typeof lowerVol === 'number') {
            targetCount = lowerVol;
            break;
          }
        }

        // CLI Invariant 3: background parentPool uses background records to ensure identity-keyed independence
        const parentPool: Record<string, Record<string, unknown>[]> = {};
        for (const [pEnt, pRows] of ctx.generatedData.entries()) {
          parentPool[pEnt] = bgRecordsByEntity.get(pEnt) ?? pRows;
        }

        // 1. Generate background records deterministically (1..targetCount)
        const backgroundRecords: Record<string, unknown>[] = [];
        const entityRng = createRng(ctx.seed, `entity:${entityName}`);
        for (let i = 1; i <= targetCount; i++) {
          const row = generateEntityRecord({
            domain: loaded.domain,
            entity: entityName,
            i,
            parentPool,
            rng: entityRng,
            identityService,
          });
          backgroundRecords.push(row);
        }
        bgRecordsByEntity.set(entityName, backgroundRecords);

        return { [entityName]: backgroundRecords };
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

  // 3. Multi-cycle retrospective simulation across the unified relational world (R4-1)
  const rng = createRng(seed);
  const startCycle = loaded.manifest.startCycle ?? asOfYear - 4;
  const cycles: number[] = [];
  for (let y = startCycle; y <= asOfYear; y++) {
    cycles.push(y);
  }

  const allUnrollCandidates: EntityCandidate[] = [];
  for (const [entityName, records] of Object.entries(allRecords)) {
    let bgIdx = 0;
    for (const r of records) {
      const id = String(r['ID'] ?? r['id']);
      const hero = heroInjector.GetHeroById(id);
      const filteredFields: Record<string, string | number | boolean | null> = {};
      for (const [k, v] of Object.entries(r)) {
        if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          filteredFields[k] = v;
        }
      }
      if (hero?.fixedFields) {
        Object.assign(filteredFields, hero.fixedFields);
      }

      const totalSpan = Math.max(1, asOfYear - startCycle + 1);
      const birthCycle = hero?.birthCycle ?? (startCycle + (bgIdx % totalSpan));
      if (!hero) {
        bgIdx++;
      }

      allUnrollCandidates.push({
        id,
        entity: entityName,
        birthCycle,
        latentDials: hero ? { ...hero.latentDials } : { theta: 0.0, phi: 0.0 },
        fixedFields: filteredFields,
        isHero: hero !== undefined,
      });
    }
  }

  const worldUnroller = new RetrospectiveUnroller({
    cycles,
    entities: allUnrollCandidates,
    heroInjector,
    motifSampler,
    ladderEngine,
    factorEngine,
    factorContracts,
    eras: loaded.erasManifest?.eras ?? [],
    domain: loaded.domain,
    cycleUnit: loaded.manifest?.cycleUnit ?? 'year',
  });

  worldUnroller.Initialize(rng);
  worldUnroller.Run(rng);

  // 4. Calibrate entity record fields against factor outcomes (domain-agnostic)
  for (const [entityName, records] of Object.entries(allRecords)) {
    const entityFactors = factorContracts.filter((f) => f.effect === entityName);
    for (const row of records) {
      const id = String(row['ID'] ?? row['id']);
      const state = worldUnroller.GetEntityState(id);
      if (state) {
        const outcomes = state.outcomesByCycle.get(asOfYear);
        for (const contract of entityFactors) {
          const hero = heroInjector.GetHeroById(id);
          const realized = outcomes ? outcomes[contract.id] : undefined;
          if (realized !== undefined && contract.outcome && contract.outcome.where) {
            const otherwise = contract.outcome.otherwise;
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
  }

  // 5. Apply ladder bindings to entity records (A4 / N6)
  for (const ladder of loaded.laddersManifest?.ladders ?? []) {
    const binding = ladder.binding;
    if (binding.mode === 'field') {
      const records = allRecords[ladder.entity] ?? [];
      for (const row of records) {
        const id = String(row['ID'] ?? row['id']);
        const state = ladderEngine.GetEntityState(ladder.ladderKey, id);
        if (state) {
          row[binding.field] = ladderEngine.GetStoredValueForState(ladder.ladderKey, state.currentState);
        }
      }
    } else if (binding.mode === 'childEntity') {
      const childRecords = allRecords[binding.childEntity] ?? [];
      for (const childRow of childRecords) {
        const parentId = String(childRow[binding.foreignKey] ?? '');
        if (parentId) {
          const state = ladderEngine.GetEntityState(ladder.ladderKey, parentId);
          if (state) {
            childRow[binding.stateField] = ladderEngine.GetStoredValueForState(ladder.ladderKey, state.currentState);
            if (binding.fixedFields) {
              for (const [k, v] of Object.entries(binding.fixedFields)) {
                childRow[k] = v;
              }
            }
          }
        }
      }
    }
  }

  // 6. Generate discrete child rows per cycle from motif childRates (A3 / 02.7)
  for (const c of cycles) {
    const activeEras = (loaded.erasManifest?.eras ?? []).filter((e) => e.cycles.includes(c));

    for (const motif of loaded.motifsManifest?.motifs ?? []) {
      const parentRecords = allRecords[motif.targetEntity] ?? [];
      for (const parentRow of parentRecords) {
        const parentId = String(parentRow['ID'] ?? parentRow['id']);
        const assignments = worldUnroller.GetMotifAssignments(parentId);
        const assignedThisMotif = assignments.some((a) => a.motifKey === motif.motifKey);
        if (!assignedThisMotif) continue;

        for (const cr of motif.childRates ?? []) {
          const childCfg = loaded.domain.entities[cr.entity];
          if (!childCfg) continue;

          const fkEntry = Object.entries(childCfg.foreignKeys ?? {}).find(
            ([_, fk]) => fk.targetEntity === motif.targetEntity
          );
          if (!fkEntry) continue;
          const fkFieldName = fkEntry[1].fieldName ?? fkEntry[0];

          let count = 0;
          const childRng = createRng(seed, `motif-child:${parentId}:${cr.entity}:${c}`);
          if (typeof cr.perCycle === 'number') {
            count = cr.perCycle;
          } else if (cr.perCycle && typeof cr.perCycle.min === 'number' && typeof cr.perCycle.max === 'number') {
            count = childRng.int(cr.perCycle.min, cr.perCycle.max);
          }

          // Apply era volume multipliers (B1 / B2)
          for (const era of activeEras) {
            for (const vm of era.volumeMultipliers) {
              if (vm.entity === cr.entity) {
                count = Math.round(count * vm.multiplier);
              }
            }
          }

          for (let k = 1; k <= count; k++) {
            const rowRng = createRng(seed, `motif-row:${parentId}:${cr.entity}:${c}:${k}`);
            const childRow = generateEntityRecord({
              domain: loaded.domain,
              entity: cr.entity,
              i: (allRecords[cr.entity]?.length ?? 0) + 1,
              parentPool: allRecords,
              rng: rowRng,
              identityService,
            });
            childRow[fkFieldName] = parentId;
            const cycleDateField = Object.keys(childCfg.fields).find(
              (f) => f === 'Cycle' || f === 'Year' || f.endsWith('Date') || f.endsWith('At')
            );
            if (cycleDateField) {
              childRow[cycleDateField] = childCfg.fields[cycleDateField]?.type === 'number' ? c : `${c}-06-15`;
            }
            if (cr.condition) {
              for (const [cf, cv] of Object.entries(cr.condition)) {
                childRow[cf] = cv;
              }
            }
            if (!allRecords[cr.entity]) {
              allRecords[cr.entity] = [];
            }
            const destList = allRecords[cr.entity];
            if (destList) {
              destList.push(childRow);
            }
          }
        }
      }
    }
  }

  // 7. Apply active era volume multipliers to transactional entities (B1, B2)
  for (const era of loaded.erasManifest?.eras ?? []) {
    for (const c of era.cycles) {
      for (const vm of era.volumeMultipliers) {
        const records = allRecords[vm.entity];
        if (!records || records.length === 0) continue;
        const entityCfg = loaded.domain.entities[vm.entity];
        if (!entityCfg) continue;

        const cycleField = Object.keys(entityCfg.fields).find(
          (f) => f === 'Cycle' || f === 'Year' || f.endsWith('Date') || f.endsWith('At')
        );

        allRecords[vm.entity] = records.filter((r) => {
          if (cycleField) {
            const raw = r[cycleField];
            if (raw) {
              const yr = typeof raw === 'number' ? raw : new Date(String(raw)).getFullYear();
              if (yr !== c) return true;
            }
          }
          if (vm.where) {
            let matches = true;
            for (const [wKey, wVal] of Object.entries(vm.where)) {
              if (r[wKey] !== undefined) {
                if (String(r[wKey]).toLowerCase() !== String(wVal).toLowerCase()) {
                  matches = false;
                  break;
                }
              } else {
                let matchedFk = false;
                for (const fk of Object.values(entityCfg.foreignKeys ?? {})) {
                  const targetList = allRecords[fk.targetEntity];
                  if (targetList) {
                    const fkVal = r[fk.fieldName ?? ''];
                    const targetRow = targetList.find(
                      (p) => String(p[fk.targetField]).toLowerCase() === String(fkVal).toLowerCase()
                    );
                    if (targetRow && targetRow[wKey] !== undefined) {
                      if (String(targetRow[wKey]).toLowerCase() === String(wVal).toLowerCase()) {
                        matchedFk = true;
                        break;
                      }
                    }
                  }
                }
                if (!matchedFk) {
                  matches = false;
                  break;
                }
              }
            }
            if (!matches) return true;
          }

          if (vm.multiplier === 0) return false;
          return true;
        });
      }
    }
  }

  // 7. Inject hero personas and additive child rows satisfying hero feature pins (A1 / CLI Invariant 3)
  for (const [entityName, entityCfg] of Object.entries(loaded.domain.entities)) {
    const entityHeroes = (loaded.heroesManifest?.heroes ?? []).filter((h) => h.entity === entityName);
    for (const hero of entityHeroes) {
      const heroRec = heroInjector.GetHero(hero.heroKey);
      if (heroRec) {
        const baseRow = generateEntityRecord({
          domain: loaded.domain,
          entity: entityName,
          i: 1,
          parentPool: allRecords,
          rng: createRng(seed, `hero:${hero.heroKey}`),
          identityService,
        });
        const heroRow: Record<string, unknown> = {
          ...baseRow,
          ID: heroRec.id,
          ...hero.businessKeys,
          ...hero.fixedFields,
        };

        const heroState = worldUnroller.GetEntityState(heroRec.id);

        // Calibrate outcomes on heroRow
        const entityFactors = factorContracts.filter((fc) => fc.effect === entityName);
        for (const contract of entityFactors) {
          const heroPin = hero.pins?.find(
            (p): p is HeroOutcomePin => p.kind === 'outcome' && p.factor === contract.id
          );
          const targetCycle = heroPin?.cycle ?? asOfYear;
          const realized = heroState?.outcomesByCycle.get(targetCycle)?.[contract.id];
          if (realized !== undefined && contract.outcome && contract.outcome.where) {
            const otherwise = contract.outcome.otherwise;
            for (const [field, targetVal] of Object.entries(contract.outcome.where)) {
              if (hero.fixedFields && field in hero.fixedFields) {
                continue;
              }
              if (realized) {
                heroRow[field] = targetVal;
              } else {
                if (typeof targetVal === 'boolean') {
                  heroRow[field] = !targetVal;
                } else if (otherwise && otherwise[field] !== undefined) {
                  heroRow[field] = otherwise[field];
                }
              }
            }
          }
        }

        // Apply ladder bindings to heroRow
        for (const ladder of loaded.laddersManifest?.ladders ?? []) {
          if (ladder.entity === entityName && ladder.binding.mode === 'field') {
            const state = ladderEngine.GetEntityState(ladder.ladderKey, heroRec.id);
            if (state) {
              heroRow[ladder.binding.field] = ladderEngine.GetStoredValueForState(ladder.ladderKey, state.currentState);
            }
          }
        }

        if (!allRecords[entityName]) allRecords[entityName] = [];
        allRecords[entityName]!.push(heroRow);
      }
    }

    // Generate hero additive child rows satisfying feature pins
    for (const hero of loaded.heroesManifest?.heroes ?? []) {
      const heroRec = heroInjector.GetHero(hero.heroKey);
      if (!heroRec) continue;
      const heroId = heroRec.id;

      const fkEntry = Object.entries(entityCfg.foreignKeys ?? {}).find(
        ([_, fk]) => fk.targetEntity === hero.entity
      );
      if (!fkEntry) continue;
      const fkFieldName = fkEntry[1].fieldName ?? fkEntry[0];

      for (const pin of hero.pins) {
        if (pin.kind === 'feature' && pin.feature.from === entityName) {
          const countNeeded =
            typeof pin.value === 'number' && (pin.op === 'gte' || pin.op === 'gt' || pin.op === 'eq')
              ? pin.value
              : 1;

          for (let j = 1; j <= countNeeded; j++) {
            const childRng = createRng(seed, `hero-child:${hero.heroKey}:${entityName}:${j}`);
            const childRow = generateEntityRecord({
              domain: loaded.domain,
              entity: entityName,
              i: (allRecords[entityName]?.length ?? 0) + 1,
              parentPool: allRecords,
              rng: childRng,
              identityService,
            });
            childRow[fkFieldName] = heroId;
            if (pin.feature.where) {
              for (const [wField, wVal] of Object.entries(pin.feature.where)) {
                childRow[wField] = wVal;
              }
            }
            if (!allRecords[entityName]) allRecords[entityName] = [];
            allRecords[entityName]!.push(childRow);
          }
        }
      }
    }
  }

  // Emit metadata tree
  const writtenMetadata = await emitMetadata({
    outputDir,
    domain: loaded.domain,
    data: allRecords,
  });
  console.log(`   ✓ Emitted ${writtenMetadata.length} metadata files to ${outputDir}`);

  // Write initial simulation checkpoint.json with populated continuity
  const totalRecordCounts: Record<string, number> = {};
  const activeEntityIds: Record<string, string[]> = {};
  const latentStates: Record<string, Record<string, number>> = {};
  const activeLifecycleStates: Record<string, Array<Record<string, unknown>>> = {};

  for (const [e, rows] of Object.entries(allRecords)) {
    totalRecordCounts[e] = rows.length;
    activeEntityIds[e] = rows.map((r) => String(r['ID'] ?? r['id']));

    for (const r of rows) {
      const id = String(r['ID'] ?? r['id']);
      const state = worldUnroller.GetEntityState(id);
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

  const birthCycles: Record<string, number> = {};
  for (const cand of allUnrollCandidates) {
    birthCycles[cand.id] = cand.birthCycle;
  }
  for (const hero of heroInjector.GetAllHeroes()) {
    birthCycles[hero.id] = hero.birthCycle;
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
      birthCycles,
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
