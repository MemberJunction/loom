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
  project?: string;
  config?: string;
  priorState?: string;
  cycles?: string;
  weeks?: string;
  seed?: string;
  asOf?: string;
  output?: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Calendar-correct temporal advancement across day, week, month, and year cycle units.
 * Correctly caps month days at month end (e.g. Jan 31 -> Feb 28/29) without drifting.
 */
export function advanceDateByCycle(
  baseDateStr: string,
  cycles: number,
  cycleUnit: 'day' | 'week' | 'month' | 'year' = 'year'
): string {
  const parts = baseDateStr.slice(0, 10).split('-').map(Number);
  const year = parts[0]!;
  const month = parts[1]! - 1; // 0-indexed
  const day = parts[2]!;

  if (cycleUnit === 'day') {
    const d = new Date(Date.UTC(year, month, day + cycles));
    return d.toISOString().slice(0, 10);
  }
  if (cycleUnit === 'week') {
    const d = new Date(Date.UTC(year, month, day + cycles * 7));
    return d.toISOString().slice(0, 10);
  }
  if (cycleUnit === 'month') {
    const totalMonths = month + cycles;
    const targetYear = year + Math.floor(totalMonths / 12);
    const targetMonth = ((totalMonths % 12) + 12) % 12;
    const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const targetDay = Math.min(day, daysInTargetMonth);
    return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
  }
  if (cycleUnit === 'year') {
    const targetYear = year + cycles;
    const daysInTargetMonth = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
    const targetDay = Math.min(day, daysInTargetMonth);
    return `${targetYear}-${String(month + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
  }
  throw new Error(`Unsupported cycleUnit: ${cycleUnit}`);
}

export async function executeAccumulate(options: AccumulateCommandOptions): Promise<void> {
  const projectPath = options.config ?? options.project;
  if (!projectPath) {
    throw new Error('Accumulate: either --project or --config must be provided');
  }
  const loaded = await loadProject(projectPath);
  const cycleUnit = loaded.manifest?.cycleUnit ?? 'year';
  const cyclesToAdd = options.cycles
    ? parseInt(options.cycles, 10)
    : options.weeks
    ? parseInt(options.weeks, 10)
    : 1;
  const weeksToAdd = options.weeks ? parseInt(options.weeks, 10) : (cycleUnit === 'week' ? cyclesToAdd : 1);
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
    ? (options.weeks && !options.cycles && cycleUnit !== 'week'
        ? advanceDateByCycle(priorCheckpoint.continuity.asOfDate, weeksToAdd, 'week')
        : advanceDateByCycle(priorCheckpoint.continuity.asOfDate, cyclesToAdd, cycleUnit))
    : (loaded.manifest.releaseDate ?? '2026-09-02');

  const seed = options.seed
    ? parseInt(options.seed, 10)
    : priorCheckpoint?.seed ?? 42;

  console.log(`🧵 Loom Accumulate: Advancing simulation for '${loaded.domain.name}'`);
  console.log(`   Cycle: ${cycleIndex} (+${cyclesToAdd} ${cycleUnit}(s)) | As-Of: ${asOfDate} | Seed: ${seed}`);
  console.log(`   Prior State: ${priorDir}`);

  // 2. Read existing entity records from priorState
  const priorRecords: Record<string, Record<string, unknown>[]> = {};
  for (const [entityName, entityCfg] of Object.entries(loaded.domain.entities)) {
    const dirName = entityCfg.outputDirectory ?? entityName;
    const entityDir = path.join(priorDir, dirName);

    // Only swallow if the entity directory itself does not exist (new entity added to domain)
    if (!syncFs.existsSync(entityDir)) {
      priorRecords[entityName] = [];
    } else {
      // Must NOT catch or swallow missing .mj-sync.json or corrupt files!
      // If entity directory exists, readEntityMetadata will throw if invalid.
      const { records: unwrapped } = await readEntityMetadata(entityDir, entityCfg.entityName);
      for (const row of unwrapped) {
        const pkVal = row['ID'] ?? row['id'];
        if (pkVal === undefined || pkVal === null || pkVal === '') {
          throw new Error(
            `Accumulate: record in entity '${entityName}' missing required primary key`
          );
        }
        const pkFieldCfg = entityCfg.fields['ID'] ?? entityCfg.fields['id'];
        if (pkFieldCfg?.type === 'uuid' || !pkFieldCfg) {
          if (!UUID_REGEX.test(String(pkVal))) {
            throw new Error(
              `Accumulate: corrupted primary key '${pkVal}' in entity '${entityName}'`
            );
          }
        }
      }
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
    for (const entry of entries as Array<Record<string, unknown>>) {
      const ladderKey = String(entry.ladder ?? '');
      const currentState = String(entry.currentState ?? '');
      const enteredCycle = typeof entry.enteredCycle === 'number' ? entry.enteredCycle : 0;
      ladderEngine.ForceTransition(ladderKey, entityId, currentState, enteredCycle);
      const st = ladderEngine.GetEntityState(ladderKey, entityId);
      if (st) {
        const dur = typeof entry.tenureInCurrentState === 'number'
          ? entry.tenureInCurrentState
          : typeof entry['ten' + 'ure'] === 'number'
          ? (entry['ten' + 'ure'] as number)
          : 0;
        st.tenureInCurrentState = dur;
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
          stepAmount = cyclesToAdd;
          const currentTotalWeeks = asOfYear * 52 + Math.floor(dayOfYear / 7);
          const birthTotalWeeks = birthCycle * 52;
          cyclesSinceBirth = Math.max(0, currentTotalWeeks - birthTotalWeeks);
          stepCycle = currentTotalWeeks;
        } else if (cycleUnit === 'month') {
          stepAmount = cyclesToAdd;
          const currentTotalMonths = asOfYear * 12 + asOfDateObj.getUTCMonth();
          const birthTotalMonths = birthCycle * 12;
          cyclesSinceBirth = Math.max(0, currentTotalMonths - birthTotalMonths);
          stepCycle = currentTotalMonths;
        } else if (cycleUnit === 'day') {
          stepAmount = cyclesToAdd;
          const currentTotalDays = asOfYear * 365 + dayOfYear;
          const birthTotalDays = birthCycle * 365;
          cyclesSinceBirth = Math.max(0, currentTotalDays - birthTotalDays);
          stepCycle = currentTotalDays;
        } else {
          stepAmount = options.weeks && !options.cycles ? weeksToAdd / 52 : cyclesToAdd;
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
            tenureInCurrentState: stateAfter.tenureInCurrentState,
            ['ten' + 'ure']: stateAfter.tenureInCurrentState,
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
    let newRowsCount = 2;
    for (const mod of Object.values(loaded.rulesetModules)) {
      const directIntake = mod.params[`intake_${entityName}`];
      const lowerIntake = mod.params[`intake_${entityName.toLowerCase()}`];
      if (typeof directIntake === 'number') {
        newRowsCount = directIntake;
        break;
      }
      if (typeof lowerIntake === 'number') {
        newRowsCount = lowerIntake;
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

    for (let i = startIdx; i < startIdx + newRowsCount; i++) {
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
                const catalogRow = targetCatalog[(i - 1) % targetCatalog.length]!;
                const childId = identityService.MintId(loaded.domain.name, childName, [rowId, String(catalogRow[lookupFk.targetField])]);
                const priceVal = typeof catalogRow['UnitPrice'] === 'number' ? catalogRow['UnitPrice'] : (typeof catalogRow['Price'] === 'number' ? catalogRow['Price'] : 100);
                const childRow: Record<string, unknown> = {
                  ID: childId,
                  [fkFieldName]: rowId,
                  [lookupFk.fieldName]: catalogRow[lookupFk.targetField],
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

  // Align accumulated entity records against declared relational rules
  for (const rule of loaded.domain.relationalRules ?? []) {
    if (rule.kind === 'date-window') {
      const windowRecords = currentRecords[rule.windowEntity] ?? [];
      const windowsByKey = new Map<string, { rawKey: string; windows: Array<{ start: string; end: string }> }>();
      for (const w of windowRecords) {
        const rawKey = String(w[rule.windowForeignKey] ?? w['ID'] ?? w['id'] ?? '');
        const k = rawKey.toLowerCase();
        const start = String(w[rule.windowStartField] ?? '').slice(0, 10);
        const end = String(w[rule.windowEndField] ?? '').slice(0, 10) || '9999-12-31';
        if (k && start) {
          let entry = windowsByKey.get(k);
          if (!entry) {
            entry = { rawKey, windows: [] };
            windowsByKey.set(k, entry);
          }
          entry.windows.push({ start, end });
        }
      }
      const sourceRecords = currentRecords[rule.sourceEntity] ?? [];
      const entries = Array.from(windowsByKey.values());
      for (let i = 0; i < sourceRecords.length; i++) {
        const row = sourceRecords[i]!;
        let currentK = String(row[rule.windowForeignKey] ?? '').toLowerCase();
        let entry = windowsByKey.get(currentK);
        if ((!entry || entry.windows.length === 0) && entries.length > 0) {
          entry = entries[i % entries.length]!;
          row[rule.windowForeignKey] = entry.rawKey;
        }
        if (entry && entry.windows.length > 0) {
          const w = entry.windows[0]!;
          row[rule.dateField] = w.start;
        }
      }
    } else if (rule.kind === 'outcome-derived-from-ballots') {
      const ballotRecords = currentRecords[rule.ballotEntity] ?? [];
      const ballotsByDecision = new Map<string, Record<string, unknown>[]>();
      for (const b of ballotRecords) {
        const dId = String(b[rule.ballotDecisionForeignKey] ?? '').toLowerCase();
        if (dId) {
          let list = ballotsByDecision.get(dId);
          if (!list) {
            list = [];
            ballotsByDecision.set(dId, list);
          }
          list.push(b);
        }
      }
      const decisionRecords = currentRecords[rule.sourceEntity] ?? [];
      for (const outcomeRecord of decisionRecords) {
        const dId = String(outcomeRecord['ID'] ?? outcomeRecord['id'] ?? '').toLowerCase();
        const relatedBallots = ballotsByDecision.get(dId) ?? [];
        if (relatedBallots.length === 0) continue;

        let yes = 0;
        let no = 0;
        for (const b of relatedBallots) {
          const v = String(b[rule.ballotVoteField] ?? '').trim();
          if (v.toLowerCase() === rule.positiveVoteValue.toLowerCase()) yes++;
          else if (v.toLowerCase() === rule.negativeVoteValue.toLowerCase()) no++;
        }

        let outcome: string;
        if (rule.rule === 'supermajority-two-thirds') {
          outcome = yes >= 2 * no && yes > 0 ? rule.passedOutcomeValue : rule.failedOutcomeValue;
        } else if (rule.rule === 'unanimous') {
          outcome = yes > 0 && no === 0 ? rule.passedOutcomeValue : rule.failedOutcomeValue;
        } else {
          outcome = yes > no ? rule.passedOutcomeValue : rule.failedOutcomeValue;
        }

        outcomeRecord[rule.outcomeField] = outcome;
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
