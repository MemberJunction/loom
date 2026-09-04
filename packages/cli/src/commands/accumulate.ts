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
  nestedEvent,
  temporalRole,
  scopedDecision,
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

  // 6. Generate simulated delta additions strictly conforming to ruleset intake
  const identityService = new IdentityService();
  identityService.RegisterNamespace(loaded.domain.name, loaded.domain.namespace);
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
      const actorType = actorFkField.replace(/ID$/i, '') || 'Participant';
      const schedule = rolePoolRule.roleWindows && rolePoolRule.roleWindows.length > 0
        ? rolePoolRule.roleWindows
        : [
            { startOffsetYears: -1, durationYears: 3 },
            { startOffsetYears: 0, durationYears: 3 },
          ];

      for (const b of parentRecords) {
        const parentId = String(b['ID'] ?? b['id']);
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

          const actorId = identityService.MintId(loaded.domain.name, actorType, [parentId, `ACCUM-${actorType}-${cycleIndex}-${a + 1}`]);
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
      const eventRecords = (eventEntity ? (currentRecords[eventEntity] ?? []) : []).slice(-newRowsCount);
      const ballotTenureRule = (loaded.domain.relationalRules ?? []).find(
        (r) => r.kind === 'date-window' && r.sourceEntity === outcomeRule.ballotEntity
      );
      const tenureRecords = ballotTenureRule && ballotTenureRule.kind === 'date-window'
        ? (currentRecords[ballotTenureRule.windowEntity] ?? [])
        : [];

      const actorFkField = ballotTenureRule && ballotTenureRule.kind === 'date-window'
        ? ballotTenureRule.windowForeignKey
        : 'ActorID';
      const tenureStartField = ballotTenureRule && ballotTenureRule.kind === 'date-window'
        ? ballotTenureRule.windowStartField
        : 'StartDate';
      const tenureEndField = ballotTenureRule && ballotTenureRule.kind === 'date-window'
        ? ballotTenureRule.windowEndField
        : 'EndDate';
      const ballotDateField = ballotTenureRule && ballotTenureRule.kind === 'date-window'
        ? ballotTenureRule.dateField
        : 'Date';

      const roleEntityCfg = ballotTenureRule && ballotTenureRule.kind === 'date-window'
        ? loaded.domain.entities[ballotTenureRule.windowEntity]
        : undefined;
      const roleParentFk = roleEntityCfg ? Object.values(roleEntityCfg.foreignKeys)[0] : undefined;

      const actorIds = Array.from(new Set(tenureRecords.map((t) => String(t[actorFkField] ?? '')))).filter(Boolean);
      const actors = actorIds.map((id) => ({ ID: id }));
      const rolePool = temporalRole({
        actors,
        roleAssignments: tenureRecords,
        actorIdOf: (a) => a.ID,
        assignmentActorIdOf: (t) => String(t[actorFkField]),
        assignmentWindowOf: (t) => ({
          start: String(t[tenureStartField]),
          end: String(t[tenureEndField]),
        }),
        scopeOf: roleParentFk ? (t) => String(t[roleParentFk.fieldName] ?? '') : undefined,
      });

      // Helper to resolve event scope matching roleParentFk target entity
      const resolveScopeId = (ev: Record<string, unknown>): string | undefined => {
        if (!roleParentFk) return undefined;
        const targetScopeEntity = roleParentFk.targetEntity;
        const eventCfg = loaded.domain.entities[eventEntity];
        if (!eventCfg) return undefined;

        const directFk = Object.values(eventCfg.foreignKeys).find((fk) => fk.targetEntity === targetScopeEntity);
        if (directFk && ev[directFk.fieldName]) {
          return String(ev[directFk.fieldName]);
        }

        for (const pFk of Object.values(eventCfg.foreignKeys)) {
          const parentRecords = currentRecords[pFk.targetEntity];
          const parentId = String(ev[pFk.fieldName] ?? '');
          if (!parentRecords || !parentId) continue;
          const parentRec = parentRecords.find((p) => String(p['ID'] ?? p['id']) === parentId);
          if (!parentRec) continue;
          const parentEntityCfg = loaded.domain.entities[pFk.targetEntity];
          if (parentEntityCfg) {
            const parentToScopeFk = Object.values(parentEntityCfg.foreignKeys).find(
              (fk) => fk.targetEntity === targetScopeEntity
            );
            if (parentToScopeFk && parentRec[parentToScopeFk.fieldName]) {
              return String(parentRec[parentToScopeFk.fieldName]);
            }
          }
        }
        return undefined;
      };

      // Event date field from relational rule
      const eventDateRule = (loaded.domain.relationalRules ?? []).find(
        (r) => r.kind === 'date-window' && r.sourceEntity === eventEntity
      );
      const eventDateField = eventDateRule && eventDateRule.kind === 'date-window'
        ? eventDateRule.dateField
        : 'Date';

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
