import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as path from 'node:path';
import { loadProject } from '../project.js';
import {
  Accumulator,
  IdentityService,
  createRng,
  appendMetadata,
  readEntityMetadata,
  ExtractPrimaryKey,
  GetPrimaryKeyFields,
  extractComposedRecords,
  FactorEngine,
  StateLadderEngine,
  nestedEvent,
  temporalRole,
  scopedDecision,
  sigmoid,
  logit,
  Validator,
} from '@memberjunction/loom-engine';
import {
  SimulationCheckpointSchema,
  type SimulationCheckpoint,
  type EraConfig,
  type DomainConfig,
} from '@memberjunction/loom-contracts';
import { generateEntityRecord } from '../generation.js';
import { loadAccumulatePlan, applyAccumulatePlan } from '../plan.js';

export interface AccumulateCommandOptions {
  project?: string;
  config?: string;
  priorState?: string;
  cycles?: string;
  weeks?: string;
  seed?: string;
  asOf?: string;
  output?: string;
  /** JSON plan of records to append this cycle (see AccumulatePlanSchema). */
  plan?: string;
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
    // A month-end date stays a month-end date (Sep 30 -> Oct 31), so monthly windows follow the calendar
    const isMonthEnd = day === new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const targetDay = isMonthEnd ? daysInTargetMonth : Math.min(day, daysInTargetMonth);
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

  // The cycle covers dates after the prior as-of date, up to and including the new one
  const windowStart = priorCheckpoint
    ? priorCheckpoint.continuity.asOfDate
    : advanceDateByCycle(asOfDate, -cyclesToAdd, cycleUnit);
  const cycleWindow = { start: windowStart, end: asOfDate };
  const inCycleWindow = (dateStr: unknown): boolean => {
    if (dateStr === undefined || dateStr === null || dateStr === '') return false;
    const day = String(dateStr).slice(0, 10);
    return day > cycleWindow.start && day <= cycleWindow.end;
  };

  // A plan is written for one cycle; applying it to another would date its records wrongly
  const plan = options.plan ? await loadAccumulatePlan(path.resolve(process.cwd(), options.plan)) : undefined;
  if (plan && plan.asOf !== asOfDate) {
    throw new Error(`Accumulate: plan is for as-of ${plan.asOf}, but this cycle's as-of date is ${asOfDate}`);
  }

  // Eras are keyed by calendar year, whatever the cycle unit
  const asOfCalendarYear = parseInt(asOfDate.slice(0, 4), 10);
  const activeEras: EraConfig[] = (loaded.erasManifest?.eras ?? []).filter((era) => era.cycles.includes(asOfCalendarYear));

  console.log(`🧵 Loom Accumulate: Advancing simulation for '${loaded.domain.name}'`);
  console.log(`   Cycle: ${cycleIndex} (+${cyclesToAdd} ${cycleUnit}(s)) | As-Of: ${asOfDate} | Seed: ${seed}`);
  console.log(`   Prior State: ${priorDir}`);
  console.log(`   Window: ${cycleWindow.start} < date <= ${cycleWindow.end}${activeEras.length ? ` | Eras: ${activeEras.map((e) => e.eraKey).join(', ')}` : ''}`);

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
      const pkFields = GetPrimaryKeyFields(entityCfg);
      for (const row of unwrapped) {
        if (ExtractPrimaryKey(row, entityCfg) === undefined) {
          throw new Error(
            `Accumulate: record in entity '${entityName}' missing required primary key '${pkFields.join(', ')}'`
          );
        }
        for (const pkField of pkFields) {
          const pkFieldCfg = entityCfg.fields[pkField];
          const pkVal = pkField === 'ID' ? row['ID'] ?? row['id'] : row[pkField];
          if ((pkFieldCfg?.type === 'uuid' || !pkFieldCfg) && !UUID_REGEX.test(String(pkVal))) {
            throw new Error(
              `Accumulate: corrupted primary key '${pkVal}' in entity '${entityName}'`
            );
          }
        }
      }
      priorRecords[entityName] = unwrapped;
    }
  }

  // Decompose any composed child records (extension, collections, embeds) into priorRecords
  const decomposedPrior = extractComposedRecords(loaded.domain, priorRecords);
  for (const [e, rows] of Object.entries(decomposedPrior)) {
    priorRecords[e] = rows;
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

  const identityService = new IdentityService();
  identityService.RegisterNamespace(loaded.domain.name, loaded.domain.namespace);

  // 5b. Append the plan's records before generation, so generated rows and cascades can build on them
  const planned = plan ? applyAccumulatePlan({ domain: loaded.domain, plan, records: currentRecords, identityService }) : undefined;
  const planAdded = planned?.added ?? {};
  if (plan) {
    console.log(`   Plan: ${plan.records.length} record(s)${plan.summary ? ` — ${plan.summary}` : ''}`);
    for (const [entity, fields] of Object.entries(planned!.nulled)) {
      console.log(`     ⚠ ${entity}: no value planned or generated for ${fields.join(', ')} (written as null)`);
    }
  }

  // 6. Generate simulated delta additions strictly conforming to ruleset intake
  const factorContracts = Object.values(loaded.rulesetModules).flatMap((mod) =>
    Object.values(mod.effects)
  );

  for (const [entityName, list] of Object.entries(currentRecords)) {
    const entityCfg = loaded.domain.entities[entityName];
    if (!entityCfg) continue;

    const isBallotCascade = (loaded.domain.relationalRules ?? []).some(
      (r) => r.kind === 'outcome-derived-from-ballots' && r.ballotEntity === entityName
    );
    if (isBallotCascade) {
      // Ballots cascaded via scopedDecision when processing decision entity
      continue;
    }

    // Read authored intake volume from ruleset params, falling back to the project's intake_default (else 2)
    let newRowsCount = 2;
    for (const mod of Object.values(loaded.rulesetModules)) {
      if (typeof mod.params['intake_default'] === 'number') {
        newRowsCount = mod.params['intake_default'];
        break;
      }
    }
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
    // Era volume multipliers scale intake for the as-of year (entity-wide multipliers only)
    for (const era of activeEras) {
      for (const vm of era.volumeMultipliers) {
        const matchesEntity =
          vm.entity === entityName || vm.entity === entityCfg.targetTable || vm.entity === entityCfg.entityName;
        if (matchesEntity && !vm.where) {
          newRowsCount = Math.round(newRowsCount * vm.multiplier);
        }
      }
    }
    // A plan's intake is the decision for this cycle; it replaces ruleset intake and era scaling
    if (plan && plan.intake[entityName] !== undefined) {
      newRowsCount = plan.intake[entityName]!;
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

    const rolePoolRule = (loaded.domain.relationalRules ?? []).find(
      (r) =>
        r.kind === 'date-window' &&
        r.windowEntity === entityName &&
        (loaded.domain.relationalRules ?? []).some(
          (or) => or.kind === 'outcome-derived-from-ballots' && or.ballotEntity === r.sourceEntity
        )
    );
    const nestedDateWindowRule = (loaded.domain.relationalRules ?? []).find(
      (r) => r.kind === 'date-window' && r.sourceEntity === entityName && currentRecords[r.windowEntity]?.length
    );
    const outcomeRule = (loaded.domain.relationalRules ?? []).find(
      (r) => r.kind === 'outcome-derived-from-ballots' && r.sourceEntity === entityName
    );

    if (rolePoolRule && rolePoolRule.kind === 'date-window') {
      const asOfYear = parseInt(asOfDate.slice(0, 4), 10) || 2026;
      const parentFk = Object.values(entityCfg.foreignKeys)[0];
      const parentRecords = parentFk ? (currentRecords[parentFk.targetEntity] ?? []) : [];
      const actorFkField = rolePoolRule.windowForeignKey;
      const schedule = rolePoolRule.roleWindows && rolePoolRule.roleWindows.length > 0
        ? rolePoolRule.roleWindows
        : [
            { startOffsetYears: -1, durationYears: 3 },
            { startOffsetYears: 0, durationYears: 3 },
          ];

      // Seats go to real actors when the actor entity is part of the domain; a domain that declares no
      // actor entity keeps minted actor IDs (there is nothing for them to dangle from)
      const actorFk = Object.values(entityCfg.foreignKeys).find(
        (fk) => fk.fieldName === actorFkField && loaded.domain.entities[fk.targetEntity]
      );
      const actorType = actorFkField.replace(/ID$/i, '') || 'Participant';
      const actorPool = actorFk ? (currentRecords[actorFk.targetEntity] ?? []) : [];
      if (actorFk && newRowsCount > 0 && actorPool.length === 0) {
        throw new Error(
          `Accumulate: ${entityName}.${actorFkField} needs real actors, but no ${actorFk?.targetEntity ?? 'actor'} records exist`
        );
      }

      for (const b of parentRecords) {
        const parentId = String(b['ID'] ?? b['id']);
        const seated = new Set(
          list
            .filter((m) => parentFk && String(m[parentFk.fieldName]) === parentId)
            .map((m) => String(m[actorFkField]))
        );
        const seatRng = rng.substream(`seats:${parentId}`);
        for (let a = 0; a < Math.min(newRowsCount, schedule.length); a++) {
          const windowDef = schedule[a]!;
          let startDate = windowDef.startDate;
          let endDate = windowDef.endDate;
          if (!startDate && windowDef.startOffsetYears !== undefined) {
            startDate = `${asOfYear + windowDef.startOffsetYears}-01-01`;
          }
          if (!endDate && windowDef.durationYears !== undefined && startDate) {
            const sYear = new Date(startDate).getFullYear();
            endDate = `${sYear + windowDef.durationYears}-12-31`;
          }
          startDate = startDate ?? asOfDate;
          endDate = endDate ?? `${asOfYear + 2}-12-31`;

          let actorId: string;
          if (actorFk) {
            const candidates = actorPool.filter((p) => !seated.has(String(p[actorFk.targetField] ?? p['ID'])));
            if (candidates.length === 0) break;
            const actor = candidates[seatRng.int(0, candidates.length - 1)]!;
            actorId = String(actor[actorFk.targetField] ?? actor['ID']);
          } else {
            actorId = identityService.MintId(loaded.domain.name, actorType, [parentId, `ACCUM-${actorType}-${cycleIndex}-${a + 1}`]);
          }
          seated.add(actorId);
          const roleId = identityService.MintId(loaded.domain.name, entityName, [parentId, actorId, startDate, String(cycleIndex)]);
          list.push({
            ID: roleId,
            ...(parentFk ? { [parentFk.fieldName]: parentId } : {}),
            [actorFkField]: actorId,
            [rolePoolRule.windowStartField]: startDate,
            [rolePoolRule.windowEndField]: endDate,
            CreatedAt: asOfDate,
          });
        }
      }
    } else if (nestedDateWindowRule && nestedDateWindowRule.kind === 'date-window') {
      const parentRecords = currentRecords[nestedDateWindowRule.windowEntity]!;
      const nestedRecords = nestedEvent({
        seed,
        parents: parentRecords.slice(-newRowsCount),
        streamKey: (p) => `accum:nested:${entityName}:${p['ID'] ?? p['id']}:cycle:${cycleIndex}`,
        countOf: () => 1,
        timing: nestedDateWindowRule.timing,
        parentWindow: (p) => ({
          start: String(p[nestedDateWindowRule.windowStartField] ?? asOfDate),
          end: String(p[nestedDateWindowRule.windowEndField] ?? asOfDate),
        }),
        spawnChild: (_childRng, p, idx, childDate) => {
          const parentId = String(p['ID'] ?? p['id']);
          const childId = identityService.MintId(loaded.domain.name, entityName, [parentId, String(idx), childDate, String(cycleIndex)]);
          return {
            ID: childId,
            [nestedDateWindowRule.windowForeignKey]: parentId,
            Title: `Accumulated ${entityName} ${idx + 1} (${p['Name'] ?? 'Event'})`,
            [nestedDateWindowRule.dateField]: childDate,
            CreatedAt: childDate,
          };
        },
      });
      list.push(...nestedRecords);
    } else if (outcomeRule && outcomeRule.kind === 'outcome-derived-from-ballots') {
      const parentFk = Object.values(entityCfg.foreignKeys)[0];
      const eventEntity = parentFk?.targetEntity ?? '';
      const decidedEventIds = new Set(
        parentFk ? list.map((d) => String(d[parentFk.fieldName] ?? '').toLowerCase()) : []
      );
      const ballotTenureRule = (loaded.domain.relationalRules ?? []).find(
        (r) => r.kind === 'date-window' && r.sourceEntity === outcomeRule.ballotEntity
      );
      if (!ballotTenureRule || ballotTenureRule.kind !== 'date-window') {
        throw new Error(`Missing required date-window rule for ${outcomeRule.ballotEntity}`);
      }
      const tenureRecords = currentRecords[ballotTenureRule.windowEntity] ?? [];

      const actorFkField = ballotTenureRule.windowForeignKey;
      const tenureStartField = ballotTenureRule.windowStartField;
      const tenureEndField = ballotTenureRule.windowEndField;
      const ballotDateField = ballotTenureRule.dateField;

      // A ballot's actor is the tenure row's actor field when it has one; when the ballot points at the
      // tenure row itself (e.g. Vote.MembershipID -> Membership.ID), the tenure row's own key is the actor
      const tenureCfg = loaded.domain.entities[ballotTenureRule.windowEntity];
      const tenureActorOf = (t: Record<string, unknown>): string =>
        String(t[actorFkField] ?? ExtractPrimaryKey(t, tenureCfg) ?? '');

      const actorIds = Array.from(new Set(tenureRecords.map(tenureActorOf))).filter(Boolean);
      const actors = actorIds.map((id) => ({ ID: id }));

      // Scope eligible voters to the nearest entity both the tenure and the event reach through foreign keys
      // (e.g. Membership -> Term -> Committee and Meeting -> Committee meet at Committee)
      const scope = resolveSharedScope(loaded.domain, currentRecords, ballotTenureRule.windowEntity, eventEntity);
      const rolePool = temporalRole({
        actors,
        roleAssignments: tenureRecords,
        actorIdOf: (a) => a.ID,
        assignmentActorIdOf: tenureActorOf,
        assignmentWindowOf: (t) => ({
          start: String(t[tenureStartField]),
          end: String(t[tenureEndField]),
        }),
        // Keys compare case-insensitively: committed rows carry upper-case UUIDs, newly minted ones lower-case
        scopeOf: scope ? (t) => (scope.fromSource(t) ?? '').toLowerCase() : undefined,
      });

      const resolveScopeId = (ev: Record<string, unknown>): string | undefined => scope?.fromTarget(ev)?.toLowerCase();

      // Event date field from relational rule
      const eventDateRule = (loaded.domain.relationalRules ?? []).find(
        (r) => r.kind === 'date-window' && r.sourceEntity === eventEntity
      );
      const eventCfgForDate = loaded.domain.entities[eventEntity];
      const eventDateField = eventDateRule && eventDateRule.kind === 'date-window'
        ? eventDateRule.dateField
        : (eventCfgForDate ? Validator.ResolveCycleField(eventCfgForDate) : undefined) ?? 'Date';

      // Decide only the events that fall inside this cycle's window and have no decision yet
      const eventRecords = (eventEntity ? (currentRecords[eventEntity] ?? []) : []).filter(
        (ev) =>
          inCycleWindow(ev[eventDateField]) &&
          !decidedEventIds.has(String(ev['ID'] ?? ev['id']).toLowerCase())
      )
        .sort((a, b) => String(a[eventDateField]).localeCompare(String(b[eventDateField])))
        .slice(0, newRowsCount);

      // Decision date field from entity schema
      const decisionDateField = Object.keys(entityCfg.fields).find(
        (f) => entityCfg.fields[f]?.type === 'date' && f !== 'CreatedAt'
      ) ?? 'CreatedAt';

      const entityFactor = factorContracts.find((fc) => fc.effect === entityName);
      const targetApprovalRate = entityFactor?.target ?? 0.6;
      const { ballots, decisions } = scopedDecision({
        seed,
        events: eventRecords,
        eligibleActorsOf: (ev) => {
          const scopeId = resolveScopeId(ev);
          return rolePool.getActiveActors(String(ev[eventDateField] ?? asOfDate), scopeId).map((r) => r.actor);
        },
        eventDateOf: (ev) => String(ev[eventDateField] ?? asOfDate),
        streamKey: (ev) => `accum:outcome:${ev['ID'] ?? ev['id']}:cycle:${cycleIndex}`,
        rule: outcomeRule.rule ?? 'majority',
        quorum: outcomeRule.quorum,
        tieRule: outcomeRule.tieRule,
        abstainHandling: outcomeRule.abstainHandling,
        abstainRate: outcomeRule.abstainRate,
        categoricalWeights: outcomeRule.categoricalWeights,
        targetApprovalRate,
        createBallot: (_ballotRng, ev, actor, vote, ballotDate) => {
          const decisionId = identityService.MintId(loaded.domain.name, entityName, [String(ev['ID'] ?? ev['id'])]);
          const ballotId = identityService.MintId(loaded.domain.name, outcomeRule.ballotEntity, [decisionId, actor.ID, String(cycleIndex)]);
          return {
            ID: ballotId,
            [outcomeRule.ballotDecisionForeignKey]: decisionId,
            [actorFkField]: actor.ID,
            [outcomeRule.ballotVoteField]: vote === 'Yes'
              ? outcomeRule.positiveVoteValue
              : vote === 'No'
              ? outcomeRule.negativeVoteValue
              : (outcomeRule.abstainVoteValue ?? 'Abstain'),
            [ballotDateField]: ballotDate,
            CreatedAt: ballotDate,
          };
        },
        createDecision: (ev, outcome, _eventBallots, decisionDate) => {
          const decisionId = identityService.MintId(loaded.domain.name, entityName, [String(ev['ID'] ?? ev['id'])]);
          return {
            ID: decisionId,
            ...(parentFk ? { [parentFk.fieldName]: ev['ID'] ?? ev['id'] } : {}),
            [outcomeRule.outcomeField]: outcome === 'Passed' ? outcomeRule.passedOutcomeValue : outcomeRule.failedOutcomeValue,
            [decisionDateField]: decisionDate,
            CreatedAt: decisionDate,
          };
        },
      });

      if (!currentRecords[outcomeRule.ballotEntity]) currentRecords[outcomeRule.ballotEntity] = [];
      currentRecords[outcomeRule.ballotEntity]!.push(...ballots);
      list.push(...decisions);
    } else {
      const pkFields = GetPrimaryKeyFields(entityCfg);
      if (newRowsCount > 0 && (pkFields.length !== 1 || pkFields[0] !== 'ID')) {
        throw new Error(
          `Accumulate: cannot generate new ${entityName} rows: it is keyed by '${pkFields.join(', ')}', not a minted ID. Set intake_${entityName} to 0.`
        );
      }
      for (let i = startIdx; i < startIdx + newRowsCount; i++) {
        const row = generateEntityRecord({
          domain: loaded.domain,
          entity: entityName,
          i,
          parentPool: currentRecords,
          rng,
          identityService,
          asOfDate,
          dateWindow: cycleWindow,
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
    }

    currentRecords[entityName] = list;
  }

  // Apply factor contract outcomes to newly generated intake records
  for (const contract of factorContracts) {
    const list = currentRecords[contract.effect];
    if (!list || !contract.outcome) continue;
    const isDerivedOutcome = (loaded.domain.relationalRules ?? []).some(
      (r) => r.kind === 'outcome-derived-from-ballots' && r.sourceEntity === contract.effect
    );
    if (isDerivedOutcome) {
      // Invariant: outcome derived strictly from ballots via scopedDecision; do not decouple
      continue;
    }
    const priorCount = priorRecords[contract.effect]?.length ?? 0;
    const newRecords = list.slice(priorCount);

    // Active eras shift the contract's rate on the logit scale, as the retrospective unroller does
    const eraDelta = activeEras
      .flatMap((era) => era.factorAdjustments)
      .filter((adj) => adj.factor === contract.id)
      .reduce((sum, adj) => sum + adj.deltaIntercept, 0);
    const targetRate = eraDelta === 0 ? contract.target : sigmoid(logit(contract.target) + eraDelta);

    for (const rec of newRecords) {
      const recId = String(rec['ID'] ?? rec['id']);
      const drawRng = createRng(seed, `intake:${contract.id}:${recId}`);
      const isPositive = drawRng.bernoulli(targetRate);
      // A planned row keeps every value the plan gave it; the contract only fills what the plan left out
      const fromPlan = planned?.supplied.get(rec);
      const set = (k: string, v: unknown) => {
        if (!fromPlan?.has(k)) rec[k] = v;
      };

      if (isPositive && contract.outcome.where) {
        for (const [k, v] of Object.entries(contract.outcome.where)) {
          set(k, v);
        }
      } else if (!isPositive && contract.outcome.otherwise) {
        for (const [k, v] of Object.entries(contract.outcome.otherwise)) {
          set(k, v);
        }
      } else if (!isPositive && contract.outcome.where) {
        for (const [k, v] of Object.entries(contract.outcome.where)) {
          if (typeof v === 'boolean') {
            set(k, false);
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

  // 8. Write the cycle onto the committed tree: prior records stay as committed, new ones are appended
  await appendMetadata({
    outputDir,
    priorDir,
    domain: loaded.domain,
    priorRecords,
    currentRecords,
  });

  // 10. Update simulation checkpoint.json with advanced continuity
  const totalRecordCounts: Record<string, number> = {};
  const activeEntityIds: Record<string, string[]> = {};

  for (const [e, rows] of Object.entries(currentRecords)) {
    totalRecordCounts[e] = rows.length;
    activeEntityIds[e] = rows.map((r) => ExtractPrimaryKey(r, loaded.domain.entities[e]) ?? String(r['ID'] ?? r['id']));
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
      metadata: {
        lastAccumulatedAt: asOfDate,
        ...(plan ? { plan: { summary: plan.summary ?? null, records: plan.records.length, added: planAdded, intake: plan.intake } } : {}),
      },
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

type RowResolver = (row: Record<string, unknown>) => string | undefined;

/**
 * Finds the nearest entity that both `sourceEntity` and `targetEntity` reach by following foreign keys
 * (up to three hops each; the target entity itself counts), and returns how to read that shared
 * ancestor's key from a row of either side. Undefined when the two share no ancestor.
 */
export function resolveSharedScope(
  domain: DomainConfig,
  records: Record<string, readonly Record<string, unknown>[]>,
  sourceEntity: string,
  targetEntity: string
): { scopeEntity: string; fromSource: RowResolver; fromTarget: RowResolver } | undefined {
  const byId = new Map<string, Map<string, Record<string, unknown>>>();
  const lookup = (entity: string, id: string): Record<string, unknown> | undefined => {
    let idx = byId.get(entity);
    if (!idx) {
      idx = new Map();
      for (const r of records[entity] ?? []) {
        const pk = ExtractPrimaryKey(r, domain.entities[entity]);
        if (pk !== undefined) idx.set(pk.toLowerCase(), r);
      }
      byId.set(entity, idx);
    }
    return idx.get(id.toLowerCase());
  };

  const ancestors = (entity: string, includeSelf: boolean): Map<string, { depth: number; resolve: RowResolver }> => {
    const found = new Map<string, { depth: number; resolve: RowResolver }>();
    if (includeSelf) {
      found.set(entity, { depth: 0, resolve: (r) => ExtractPrimaryKey(r, domain.entities[entity]) });
    }
    const queue: Array<{ entity: string; depth: number; resolve: RowResolver }> = [
      { entity, depth: 0, resolve: (r) => ExtractPrimaryKey(r, domain.entities[entity]) },
    ];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.depth >= 3) continue;
      for (const fk of Object.values(domain.entities[cur.entity]?.foreignKeys ?? {})) {
        if (!domain.entities[fk.targetEntity] || found.has(fk.targetEntity)) continue;
        const parentResolve: RowResolver = (row) => {
          const ownKey = cur.resolve(row);
          if (ownKey === undefined) return undefined;
          const own = cur.depth === 0 ? row : lookup(cur.entity, ownKey);
          const val = own?.[fk.fieldName];
          return val === undefined || val === null || val === '' ? undefined : String(val);
        };
        const next = { entity: fk.targetEntity, depth: cur.depth + 1, resolve: parentResolve };
        found.set(fk.targetEntity, { depth: next.depth, resolve: parentResolve });
        queue.push(next);
      }
    }
    return found;
  };

  const sourceAncestors = ancestors(sourceEntity, false);
  const targetAncestors = ancestors(targetEntity, true);
  let best: { scopeEntity: string; depth: number; fromSource: RowResolver; fromTarget: RowResolver } | undefined;
  for (const [entity, src] of sourceAncestors) {
    const tgt = targetAncestors.get(entity);
    if (!tgt) continue;
    const depth = src.depth + tgt.depth;
    if (!best || depth < best.depth) {
      best = { scopeEntity: entity, depth, fromSource: src.resolve, fromTarget: tgt.resolve };
    }
  }
  return best && { scopeEntity: best.scopeEntity, fromSource: best.fromSource, fromTarget: best.fromTarget };
}
