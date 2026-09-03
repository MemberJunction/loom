import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as path from 'node:path';
import { loadProject } from '../project.js';
import {
  Accumulator,
  IdentityService,
  createRng,
  emitMetadata,
  readEntityMetadata,
  FactorEngine,
  StateLadderEngine,
} from '@memberjunction/loom-engine';
import {
  SimulationCheckpointSchema,
  type SimulationCheckpoint,
} from '@memberjunction/loom-contracts';
import { generateEntityRecord } from '../generation.js';

export interface AccumulateCommandOptions {
  project: string;
  priorState?: string;
  weeks?: string;
  seed?: string;
  asOf?: string;
  output?: string;
}

function advanceDate(baseDateStr: string, days: number): string {
  const d = new Date(baseDateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function executeAccumulate(options: AccumulateCommandOptions): Promise<void> {
  const loaded = await loadProject(options.project);
  const weeksToAdd = options.weeks ? parseInt(options.weeks, 10) : 1;
  const outputDir = options.output
    ? path.resolve(process.cwd(), options.output)
    : path.resolve(loaded.projectDir, loaded.manifest.output.metadataDir);

  const priorDir = options.priorState
    ? path.resolve(process.cwd(), options.priorState)
    : outputDir;

  // 1. Read prior checkpoint if available
  const checkpointPath = path.join(priorDir, 'checkpoint.json');
  let priorCheckpoint: SimulationCheckpoint | null = null;
  try {
    const raw = await fs.readFile(checkpointPath, 'utf8');
    try {
      priorCheckpoint = SimulationCheckpointSchema.parse(JSON.parse(raw));
    } catch (parseErr) {
      throw new Error(
        `Accumulate: corrupted checkpoint at '${checkpointPath}': ${
          parseErr instanceof Error ? parseErr.message : String(parseErr)
        }`
      );
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  const cycleIndex = (priorCheckpoint?.cycleIndex ?? 0) + 1;
  const asOfDate = options.asOf
    ? options.asOf
    : priorCheckpoint
    ? advanceDate(priorCheckpoint.continuity.asOfDate, weeksToAdd * 7)
    : (loaded.manifest.releaseDate ?? '2026-09-02');

  const seed = options.seed
    ? parseInt(options.seed, 10)
    : priorCheckpoint?.seed ?? 42;

  console.log(`🧵 Loom Accumulate: Advancing simulation for '${loaded.domain.name}'`);
  console.log(`   Cycle: ${cycleIndex} (+${weeksToAdd} week(s)) | As-Of: ${asOfDate} | Seed: ${seed}`);
  console.log(`   Prior State: ${priorDir}`);

  // 2. Read existing entity records from priorState
  const priorRecords: Record<string, Record<string, unknown>[]> = {};
  for (const [entityName, entityCfg] of Object.entries(loaded.domain.entities)) {
    const entityDir = path.join(priorDir, entityName);

    // Only swallow if the entity directory itself does not exist (new entity added to domain)
    if (!syncFs.existsSync(entityDir)) {
      priorRecords[entityName] = [];
    } else {
      // Must NOT catch or swallow missing .mj-sync.json or corrupt files!
      // If entity directory exists, readEntityMetadata will throw if invalid.
      const { records: unwrapped } = await readEntityMetadata(entityDir, entityCfg.entityName);
      priorRecords[entityName] = unwrapped;
    }
  }

  // 3. Continuity check
  if (priorCheckpoint && priorCheckpoint.domain !== loaded.domain.name) {
    throw new Error(
      `Accumulate: checkpoint domain '${priorCheckpoint.domain}' does not match project domain '${loaded.domain.name}'`
    );
  }

  // Check seed continuity
  if (priorCheckpoint && options.seed && parseInt(options.seed, 10) !== priorCheckpoint.seed) {
    console.warn(`   ⚠️ Warning: seed ${options.seed} differs from checkpoint seed ${priorCheckpoint.seed}; maintaining checkpoint continuity`);
  }

  // 4. Advance latent dial profiles from continuity
  const factorEngine = new FactorEngine();

  const updatedLatentStates: Record<string, Record<string, number>> = {
    ...(priorCheckpoint?.continuity.latentStates ?? {}),
  };

  for (const [id, dials] of Object.entries(updatedLatentStates)) {
    const entRng = createRng(seed, `latent:${id}:${cycleIndex}`);
    const advanced = factorEngine.AdvanceProfile(entRng, { entityId: id, dials }, 1);
    updatedLatentStates[id] = advanced.dials;
  }

  // 5. Rehydrate StateLadderEngine from continuity and step ladders (R3-4)
  const ladderEngine = new StateLadderEngine(loaded.laddersManifest?.ladders ?? []);
  const priorLifecycles = priorCheckpoint?.continuity.activeLifecycleStates ?? {};
  for (const [entityId, entries] of Object.entries(priorLifecycles)) {
    for (const entry of entries as Array<{ ladder: string; currentState: string; enteredCycle: number; tenure?: number }>) {
      ladderEngine.ForceTransition(entry.ladder, entityId, entry.currentState, entry.enteredCycle);
      const st = ladderEngine.GetEntityState(entry.ladder, entityId);
      if (st) {
        st.tenureInCurrentState = entry.tenure ?? 0;
      }
    }
  }

  // Initialize currentRecords from priorRecords
  const currentRecords: Record<string, Record<string, unknown>[]> = {};
  for (const [entityName, existingList] of Object.entries(priorRecords)) {
    currentRecords[entityName] = existingList.map((r) => ({ ...r }));
  }

  const updatedLifecycleStates: Record<string, Array<Record<string, unknown>>> = {};
  const statusTransitions: Array<{
    entity: string;
    id: string;
    fromStatus: string;
    toStatus: string;
    effectiveDate: string;
  }> = [];

  for (const ladder of ladderEngine.GetAllLadders()) {
    const targetRecords = currentRecords[ladder.entity] ?? [];
    for (const row of targetRecords) {
      const entityId = String(row['ID'] ?? row['id']);
      const curState = ladderEngine.GetEntityState(ladder.ladderKey, entityId);
      if (curState) {
        const dials = updatedLatentStates[entityId] ?? {};
        const cycleUnit = loaded.manifest?.cycleUnit ?? 'year';
        let stepAmount = 1;
        let cyclesSinceBirth = 0;
        let stepCycle = cycleIndex;

        const asOfYear = parseInt(asOfDate.slice(0, 4), 10) || 2026;
        const asOfDateObj = new Date(asOfDate);
        const dayOfYear = Math.floor(
          (asOfDateObj.getTime() - new Date(Date.UTC(asOfYear, 0, 1)).getTime()) / 86400000
        );

        const birthCycle = priorCheckpoint?.continuity.birthCycles?.[entityId] ?? curState.enteredCycle;

        if (cycleUnit === 'week') {
          stepAmount = weeksToAdd;
          const currentTotalWeeks = asOfYear * 52 + Math.floor(dayOfYear / 7);
          const birthTotalWeeks = birthCycle * 52;
          cyclesSinceBirth = Math.max(0, currentTotalWeeks - birthTotalWeeks);
          stepCycle = currentTotalWeeks;
        } else {
          stepAmount = weeksToAdd / 52;
          const currentContinuousCycle = asOfYear + dayOfYear / 365.25;
          cyclesSinceBirth = Math.max(0, currentContinuousCycle - birthCycle);
          stepCycle = Math.floor(currentContinuousCycle);
        }

        const stepResult = ladderEngine.StepEntity(ladder.ladderKey, entityId, {
          cycle: stepCycle,
          cyclesSinceBirth,
          latentDials: dials,
          stepAmount,
        });

        const stateAfter = ladderEngine.GetEntityState(ladder.ladderKey, entityId);
        if (stateAfter) {
          if (!updatedLifecycleStates[entityId]) updatedLifecycleStates[entityId] = [];
          updatedLifecycleStates[entityId].push({
            ladder: ladder.ladderKey,
            currentState: stateAfter.currentState,
            enteredCycle: stateAfter.enteredCycle,
            tenure: stateAfter.tenureInCurrentState,
          });
        }

        if (stepResult.transitioned && stepResult.newState) {
          const targetEntity = ladder.binding.mode === 'childEntity' ? ladder.binding.childEntity : ladder.entity;
          const stateField = ladder.binding.mode === 'childEntity' ? ladder.binding.stateField : ladder.binding.field;

          if (ladder.binding.mode === 'childEntity') {
            const childRecords = currentRecords[ladder.binding.childEntity] ?? [];
            for (const childRow of childRecords) {
              if (String(childRow[ladder.binding.foreignKey]) === entityId) {
                const prevVal = String(childRow[stateField] ?? curState.currentState);
                childRow[stateField] = stepResult.newState;
                statusTransitions.push({
                  entity: targetEntity,
                  id: String(childRow['ID'] ?? childRow['id']),
                  fromStatus: prevVal,
                  toStatus: stepResult.newState,
                  effectiveDate: asOfDate,
                });
              }
            }
          } else {
            if (stateField && row[stateField] !== undefined) {
              row[stateField] = stepResult.newState;
            }
            statusTransitions.push({
              entity: targetEntity,
              id: entityId,
              fromStatus: curState.currentState,
              toStatus: stepResult.newState,
              effectiveDate: asOfDate,
            });
          }
        }
      }
    }
  }

  // 6. Generate simulated delta additions strictly conforming to ruleset intake
  const identityService = new IdentityService();
  identityService.RegisterNamespace(loaded.domain.name, loaded.domain.namespace);

  for (const [entityName, list] of Object.entries(currentRecords)) {
    const entityCfg = loaded.domain.entities[entityName];
    if (!entityCfg) continue;

    // Read authored intake volume from ruleset params, falling back to default 2
    let newItemsCount = 2;
    for (const mod of Object.values(loaded.rulesetModules)) {
      const directIntake = mod.params[`intake_${entityName}`];
      const lowerIntake = mod.params[`intake_${entityName.toLowerCase()}`];
      if (typeof directIntake === 'number') {
        newItemsCount = directIntake;
        break;
      }
      if (typeof lowerIntake === 'number') {
        newItemsCount = lowerIntake;
        break;
      }
    }

    // Check if this entity is a structural dependent child of another entity
    let isChild = false;
    for (const [pName] of Object.entries(loaded.domain.entities)) {
      if (pName === entityName) continue;
      for (const fk of Object.values(entityCfg.foreignKeys ?? {})) {
        if (fk.targetEntity === pName) {
          const isDependent = fk.dependent === true;
          if (isDependent) {
            isChild = true;
            break;
          }
        }
      }
      if (isChild) break;
    }
    if (isChild) {
      // Dependent child records are generated in cascade with their parent entity
      continue;
    }

    const startIdx = list.length + 1;
    const rng = createRng(seed, `accumulate:${entityName}:cycle:${cycleIndex}`);

    for (let i = startIdx; i < startIdx + newItemsCount; i++) {
      const row = generateEntityRecord({
        domain: loaded.domain,
        entity: entityName,
        i,
        parentPool: currentRecords,
        rng,
        identityService,
      });
      list.push(row);

      // Cascade structural dependent children matching domain schema
      for (const [childName, childCfg] of Object.entries(loaded.domain.entities)) {
        if (childName === entityName) continue;
        for (const [fkKey, fk] of Object.entries(childCfg.foreignKeys ?? {})) {
          if (fk.targetEntity === entityName) {
            const isDependent = fk.dependent === true;
            if (!isDependent) continue;
            const fkFieldName = fk.fieldName ?? fkKey;

            if (!currentRecords[childName]) currentRecords[childName] = [];

            const rowId = String(row['ID'] ?? row['id']);
            const otherFks = Object.values(childCfg.foreignKeys ?? {}).filter((f) => f.targetEntity !== entityName);

            if (otherFks.length > 0) {
              const lookupFk = otherFks[0]!;
              const targetCatalog = currentRecords[lookupFk.targetEntity] ?? [];
              if (targetCatalog.length > 0) {
                const item = targetCatalog[(i - 1) % targetCatalog.length]!;
                const childId = identityService.MintId(loaded.domain.name, childName, [rowId, String(item[lookupFk.targetField])]);
                const priceVal = typeof item['UnitPrice'] === 'number' ? item['UnitPrice'] : (typeof item['Price'] === 'number' ? item['Price'] : 100);
                const childRow: Record<string, unknown> = {
                  ID: childId,
                  [fkFieldName]: rowId,
                  [lookupFk.fieldName]: item[lookupFk.targetField],
                };
                for (const [fName, fDef] of Object.entries(childCfg.fields)) {
                  if (fName === 'ID' || fName === fkFieldName || fName === lookupFk.fieldName) continue;
                  if (fName.toLowerCase().includes('quantity') || fName.toLowerCase().includes('qty')) {
                    childRow[fName] = 1;
                  } else if (fName.toLowerCase().includes('unitprice')) {
                    childRow[fName] = priceVal;
                  } else if (fName.toLowerCase().includes('extended') || fName.toLowerCase().includes('total')) {
                    childRow[fName] = priceVal;
                  } else if (fDef.type === 'string') {
                    childRow[fName] = 'Standard';
                  }
                }
                currentRecords[childName]!.push(childRow);
                for (const fName of Object.keys(entityCfg.fields)) {
                  if (fName.toLowerCase().includes('total') || fName.toLowerCase().includes('amount')) {
                    row[fName] = priceVal;
                  }
                }
              }
            } else {
              const dateField = Object.keys(childCfg.fields).find(
                (f) => f.toLowerCase().includes('date') || f.toLowerCase().includes('time')
              );
              const childId = identityService.MintId(loaded.domain.name, childName, [rowId, asOfDate]);
              const childRow: Record<string, unknown> = {
                ID: childId,
                [fkFieldName]: rowId,
              };
              for (const [fName, fDef] of Object.entries(childCfg.fields)) {
                if (fName === 'ID' || fName === fkFieldName) continue;
                if (fName === dateField) {
                  childRow[fName] = asOfDate;
                } else if (fName.toLowerCase().includes('amount') || fName.toLowerCase().includes('total')) {
                  const totalField = Object.keys(entityCfg.fields).find(
                    (f) => f.toLowerCase().includes('total') || f.toLowerCase().includes('amount')
                  );
                  childRow[fName] = totalField && typeof row[totalField] === 'number' ? row[totalField] : 100;
                } else if (fName.toLowerCase().includes('status')) {
                  childRow[fName] = 'Completed';
                } else if (fDef.type === 'string') {
                  childRow[fName] = 'Standard';
                }
              }
              currentRecords[childName]!.push(childRow);
            }
          }
        }
      }
    }

    currentRecords[entityName] = list;
  }

  // Apply factor contract outcomes to newly generated intake records
  const factorContracts = Object.values(loaded.rulesetModules).flatMap((mod) =>
    Object.values(mod.effects)
  );
  for (const contract of factorContracts) {
    const list = currentRecords[contract.effect];
    if (!list || !contract.outcome) continue;
    const priorCount = priorRecords[contract.effect]?.length ?? 0;
    const newRecords = list.slice(priorCount);

    for (const rec of newRecords) {
      const recId = String(rec['ID'] ?? rec['id']);
      const drawRng = createRng(seed, `intake:${contract.id}:${recId}`);
      const isPositive = drawRng.bernoulli(contract.target);

      if (isPositive && contract.outcome.where) {
        for (const [k, v] of Object.entries(contract.outcome.where)) {
          rec[k] = v;
        }
      } else if (!isPositive && contract.outcome.otherwise) {
        for (const [k, v] of Object.entries(contract.outcome.otherwise)) {
          rec[k] = v;
        }
      } else if (!isPositive && contract.outcome.where) {
        for (const [k, v] of Object.entries(contract.outcome.where)) {
          if (typeof v === 'boolean') {
            rec[k] = false;
          }
        }
      }
    }
  }

  // 7. Compute pure delta using Accumulator (enforces no deletions byte-for-byte)
  const accumulator = new Accumulator();
  const diff = accumulator.ComputeDelta(
    loaded.domain,
    cycleIndex,
    asOfDate,
    priorRecords,
    currentRecords
  );

  console.log(`   Delta Summary:`);
  for (const [entity, rows] of Object.entries(diff.delta.generatedRecords)) {
    console.log(`     • ${entity}: +${rows.length} new record(s)`);
  }
  if (statusTransitions.length > 0) {
    console.log(`     • Status Transitions: ${statusTransitions.length} transition(s)`);
  }

  // 8. Update metadata directory
  await emitMetadata({
    outputDir,
    domain: loaded.domain,
    data: currentRecords,
  });

  // 10. Update simulation checkpoint.json with advanced continuity
  const totalRecordCounts: Record<string, number> = {};
  const activeEntityIds: Record<string, string[]> = {};

  for (const [e, rows] of Object.entries(currentRecords)) {
    totalRecordCounts[e] = rows.length;
    activeEntityIds[e] = rows.map((r) => String(r['ID'] ?? r['id']));
  }

  const updatedCheckpoint: SimulationCheckpoint = {
    domain: loaded.domain.name,
    seed,
    releaseDate: asOfDate,
    cycleIndex,
    continuity: {
      asOfDate,
      cycleIndex,
      activeEntityIds,
      latentStates: updatedLatentStates,
      activeLifecycleStates: updatedLifecycleStates,
      birthCycles: priorCheckpoint?.continuity.birthCycles ?? {},
      metadata: { lastAccumulatedAt: asOfDate },
    },
    committedRecordCounts: totalRecordCounts,
    lastGeneratedDelta: {
      ...diff.delta,
      statusTransitions,
    },
  };

  await fs.writeFile(
    path.join(outputDir, 'checkpoint.json'),
    JSON.stringify(updatedCheckpoint, null, 2),
    'utf8'
  );

  console.log(`   ✓ Saved checkpoint to: ${path.join(outputDir, 'checkpoint.json')}`);
  console.log(`✨ Accumulation complete.`);
}
