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
  nestedEvent,
  temporalRole,
  scopedDecision,
  type SimulationNode,
  type EntityCandidate,
} from '@memberjunction/loom-engine';
import type { SimulationCheckpoint, HeroOutcomePin, EraConfig, FieldConfig } from '@memberjunction/loom-contracts';
import { generateEntityRecord } from '../generation.js';

function resolveComplement(targetVal: unknown, fieldCfg?: FieldConfig): unknown {
  if (typeof targetVal === 'boolean') {
    return !targetVal;
  }
  if (fieldCfg?.values && Array.isArray(fieldCfg.values) && fieldCfg.values.length === 2) {
    const norm = String(targetVal).trim().toLowerCase();
    const complement = fieldCfg.values.find((v) => String(v).trim().toLowerCase() !== norm);
    if (complement !== undefined) {
      return complement;
    }
  }
  return undefined;
}

export interface BuildCommandOptions {
  project?: string;
  config?: string;
  seed?: string;
  release?: string;
  output?: string;
}

export async function executeBuild(options: BuildCommandOptions): Promise<void> {
  const projectPath = options.config ?? options.project;
  if (!projectPath) {
    throw new Error('Build: either --project or --config must be provided');
  }
  const loaded = await loadProject(projectPath);
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

  function cascadeDependentChildren(params: {
    parentEntity: string;
    parentRow: Record<string, unknown>;
    cycle: number;
    activeEras: readonly EraConfig[];
  }): { hasLineChild: boolean; lineCount: number } {
    const { parentEntity, parentRow, cycle, activeEras } = params;
    const parentId = String(parentRow['ID'] ?? parentRow['id']);
    let hasLineChild = false;
    let totalLinesGenerated = 0;

    for (const [childName, childCfg] of Object.entries(loaded.domain.entities)) {
      if (childName === parentEntity) continue;
      for (const [fkKey, fk] of Object.entries(childCfg.foreignKeys ?? {})) {
        if (fk.targetEntity === parentEntity) {
          const isDependent = fk.dependent === true;
          if (!isDependent) continue;

          const fkFieldName = fk.fieldName ?? fkKey;
          const otherFks = Object.values(childCfg.foreignKeys ?? {}).filter(
            (f) => f.targetEntity !== parentEntity
          );

          if (otherFks.length > 0) {
            hasLineChild = true;
            const lookupFk = otherFks[0]!;
            const targetCatalog = allRecords[lookupFk.targetEntity] ?? [];
            if (targetCatalog.length === 0) {
              return { hasLineChild: true, lineCount: 0 };
            }

            const parentHash = parentId.replace(/-/g, '').slice(0, 8);
            const candidateCount = 1 + (parseInt(parentHash, 16) % 2);
            const generatedLines: Record<string, unknown>[] = [];
            let sumTotal = 0;

            for (let l = 1; l <= candidateCount; l++) {
              const catalogIdx = (parseInt(parentHash, 16) + l) % targetCatalog.length;
              const catalogRow = targetCatalog[catalogIdx]!;

              // Evaluate active era volume multipliers on this candidate line (R12-1, R12-2)
              let dropLine = false;
              for (const era of activeEras) {
                for (const vm of era.volumeMultipliers) {
                  if (vm.entity === childName) {
                    let matchesWhere = true;
                    if (vm.where) {
                      for (const [wk, wv] of Object.entries(vm.where)) {
                        if (catalogRow[wk] === undefined || String(catalogRow[wk]).toLowerCase() !== String(wv).toLowerCase()) {
                          matchesWhere = false;
                          break;
                        }
                      }
                    }
                    if (matchesWhere) {
                      if (vm.multiplier === 0) {
                        dropLine = true;
                        break;
                      } else if (vm.multiplier > 0 && vm.multiplier < 1) {
                        // Deterministic thinning using parent:cycle:l stream (R12-2)
                        const thinRng = createRng(seed, `thin:${parentId}:${childName}:${cycle}:${l}`);
                        if (!thinRng.bernoulli(vm.multiplier)) {
                          dropLine = true;
                          break;
                        }
                      }
                    }
                  }
                }
                if (dropLine) break;
              }
              if (dropLine) continue;

              // Candidate line is kept
              const qty = 1 + (l % 2);
              const priceVal = typeof catalogRow['UnitPrice'] === 'number' ? catalogRow['UnitPrice'] : (typeof catalogRow['Price'] === 'number' ? catalogRow['Price'] : 100);
              const extVal = qty * priceVal;
              sumTotal += extVal;

              const lineId = identityService.MintId(loaded.domain.name, childName, [parentId, String(catalogRow[lookupFk.targetField])]);
              const childRow: Record<string, unknown> = {
                ID: lineId,
                [fkFieldName]: parentId,
                [lookupFk.fieldName]: catalogRow[lookupFk.targetField],
              };
              for (const [fName, fDef] of Object.entries(childCfg.fields)) {
                if (fName === 'ID' || fName === fkFieldName || fName === lookupFk.fieldName) continue;
                if (fName.toLowerCase().includes('quantity') || fName.toLowerCase().includes('qty')) {
                  childRow[fName] = qty;
                } else if (fName.toLowerCase().includes('unitprice')) {
                  childRow[fName] = priceVal;
                } else if (fName.toLowerCase().includes('extended') || fName.toLowerCase().includes('total')) {
                  childRow[fName] = extVal;
                } else if (fDef.type === 'string') {
                  childRow[fName] = 'Standard';
                }
              }
              generatedLines.push(childRow);
            }

            if (generatedLines.length === 0) {
              // All candidate lines suppressed by era multipliers (R12-1)
              return { hasLineChild: true, lineCount: 0 };
            }

            if (!allRecords[childName]) allRecords[childName] = [];
            allRecords[childName]!.push(...generatedLines);
            totalLinesGenerated += generatedLines.length;

            for (const fName of Object.keys(loaded.domain.entities[parentEntity]!.fields)) {
              if (fName.toLowerCase().includes('total') || fName.toLowerCase().includes('amount')) {
                parentRow[fName] = sumTotal;
              }
            }
          } else {
            // Payment / transaction audit child: only generated if parent was not suppressed
            if (!allRecords[childName]) allRecords[childName] = [];
            const dateField = Object.keys(childCfg.fields).find(
              (f) => f.toLowerCase().includes('date') || f.toLowerCase().includes('time')
            );
            const parentDateField = Object.keys(loaded.domain.entities[parentEntity]!.fields).find(
              (f) => f.toLowerCase().includes('date') || f.toLowerCase().includes('time')
            );
            const eventDate = String(parentDateField && parentRow[parentDateField] ? parentRow[parentDateField] : `${cycle}-06-15`);
            const childId = identityService.MintId(loaded.domain.name, childName, [parentId, eventDate]);
            const childRow: Record<string, unknown> = {
              ID: childId,
              [fkFieldName]: parentId,
            };
            for (const [fName, fDef] of Object.entries(childCfg.fields)) {
              if (fName === 'ID' || fName === fkFieldName) continue;
              if (fName === dateField) {
                childRow[fName] = eventDate;
              } else if (fName.toLowerCase().includes('amount') || fName.toLowerCase().includes('total')) {
                const totalField = Object.keys(loaded.domain.entities[parentEntity]!.fields).find(
                  (f) => f.toLowerCase().includes('total') || f.toLowerCase().includes('amount')
                );
                childRow[fName] = totalField && typeof parentRow[totalField] === 'number' ? parentRow[totalField] : 100;
              } else if (fName.toLowerCase().includes('status')) {
                childRow[fName] = 'Completed';
              } else if (fDef.type === 'string') {
                childRow[fName] = 'Standard';
              }
            }
            allRecords[childName]!.push(childRow);
          }
        }
      }
    }
    return { hasLineChild, lineCount: totalLinesGenerated };
  }

  // Create simulation DAG nodes for each entity defined in domain.json
  const bgRecordsByEntity = new Map<string, Record<string, unknown>[]>();
  const allRecords: Record<string, Record<string, unknown>[]> = {};
  if (loaded.catalogs) {
    for (const [catEnt, catRows] of Object.entries(loaded.catalogs)) {
      allRecords[catEnt] = [...catRows] as Record<string, unknown>[];
    }
  }

  for (const [entityName, entityCfg] of Object.entries(loaded.domain.entities)) {
    const node: SimulationNode = {
      id: `node-${entityName.toLowerCase()}`,
      consumes: Object.values(entityCfg.foreignKeys)
        .map((fk) => fk.targetEntity)
        .filter((target) => target in loaded.domain.entities),
      produces: [entityName],
      description: `Generates ${entityName} records with causal factor calibration`,
      execute: async (ctx) => {
        // If records were already cascaded into allRecords (e.g. OrderLine, Payment), return them
        if (allRecords[entityName] && allRecords[entityName]!.length > 0) {
          bgRecordsByEntity.set(entityName, allRecords[entityName]!);
          return { [entityName]: allRecords[entityName]! };
        }

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
        if (loaded.catalogs) {
          for (const [catEnt, catRows] of Object.entries(loaded.catalogs)) {
            if (!parentPool[catEnt]) {
              parentPool[catEnt] = [...catRows] as Record<string, unknown>[];
            }
          }
        }

        // 1. Generate background records deterministically (1..targetCount)
        const backgroundRecords: Record<string, unknown>[] = [];
        const entityRng = createRng(ctx.seed, `entity:${entityName}`);

        const rolePoolRule = (loaded.domain.relationalRules ?? []).find(
          (r) =>
            r.kind === 'date-window' &&
            r.windowEntity === entityName &&
            (loaded.domain.relationalRules ?? []).some(
              (or) => or.kind === 'outcome-derived-from-ballots' && or.ballotEntity === r.sourceEntity
            )
        );
        const nestedDateWindowRule = (loaded.domain.relationalRules ?? []).find(
          (r) => r.kind === 'date-window' && r.sourceEntity === entityName && parentPool[r.windowEntity]?.length
        );
        const outcomeRule = (loaded.domain.relationalRules ?? []).find(
          (r) => r.kind === 'outcome-derived-from-ballots' && r.sourceEntity === entityName
        );

        if (rolePoolRule && rolePoolRule.kind === 'date-window') {
          // Temporal role assignment pool generation: generate role records spanning the simulation era
          const parentFk = Object.values(entityCfg.foreignKeys)[0];
          const parentRecords = parentFk ? (parentPool[parentFk.targetEntity] ?? []) : [];
          const actorFkField = rolePoolRule.windowForeignKey;
          const actorType = actorFkField.replace(/ID$/i, '') || 'Participant';
          const schedule = rolePoolRule.roleWindows && rolePoolRule.roleWindows.length > 0
            ? rolePoolRule.roleWindows
            : [
                { startOffsetYears: -5, durationYears: 3 },
                { startOffsetYears: -4, durationYears: 3 },
                { startOffsetYears: -3, durationYears: 5 },
                { startOffsetYears: -1, durationYears: 4 },
                { startOffsetYears: 0, durationYears: 3 },
              ];

          for (const b of parentRecords) {
            const parentId = String(b['ID'] ?? b['id']);
            for (let a = 0; a < schedule.length; a++) {
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
              startDate = startDate ?? `${startCycle}-01-01`;
              endDate = endDate ?? `${asOfYear + 2}-12-31`;

              const actorId = identityService.MintId(loaded.domain.name, actorType, [parentId, `ACTOR-${a + 1}`]);
              const roleId = identityService.MintId(loaded.domain.name, entityName, [parentId, actorId, startDate]);
              backgroundRecords.push({
                ID: roleId,
                ...(parentFk ? { [parentFk.fieldName]: parentId } : {}),
                [actorFkField]: actorId,
                [rolePoolRule.windowStartField]: startDate,
                [rolePoolRule.windowEndField]: endDate,
                CreatedAt: startDate,
              });
            }
          }
        } else if (nestedDateWindowRule && nestedDateWindowRule.kind === 'date-window') {
          // Pattern A: nestedEvent - events bounded within parent window
          const parentRecords = parentPool[nestedDateWindowRule.windowEntity]!;
          const itemsPerParent = Math.max(1, Math.floor(targetCount / parentRecords.length)) || 2;
          const nestedRecords = nestedEvent({
            seed: ctx.seed,
            parents: parentRecords,
            streamKey: (p) => `nested:${entityName}:${p['ID'] ?? p['id']}`,
            countOf: () => itemsPerParent,
            timing: nestedDateWindowRule.timing,
            parentWindow: (p) => ({
              start: String(p[nestedDateWindowRule.windowStartField] ?? releaseDate),
              end: String(p[nestedDateWindowRule.windowEndField] ?? releaseDate),
            }),
            spawnChild: (_childRng, p, idx, childDate) => {
              const parentId = String(p['ID'] ?? p['id']);
              const childId = identityService.MintId(loaded.domain.name, entityName, [parentId, String(idx), childDate]);
              const childRow: Record<string, unknown> = {
                ID: childId,
                [nestedDateWindowRule.windowForeignKey]: parentId,
                [nestedDateWindowRule.dateField]: childDate,
                CreatedAt: childDate,
              };
              for (const [fName, fDef] of Object.entries(entityCfg.fields)) {
                if (fName in childRow) continue;
                if (fDef.type === 'string') {
                  childRow[fName] = `${entityName} ${idx + 1} (${p['Name'] ?? 'Event'})`;
                } else if (fDef.type === 'date') {
                  childRow[fName] = childDate;
                }
              }
              return childRow;
            },
          });
          backgroundRecords.push(...nestedRecords);
        } else if (outcomeRule && outcomeRule.kind === 'outcome-derived-from-ballots') {
          // Pattern B: temporalRole + Pattern C: scopedDecision
          const parentFk = Object.values(entityCfg.foreignKeys)[0];
          const eventEntity = parentFk?.targetEntity ?? '';
          const eventRecords = (eventEntity ? (parentPool[eventEntity] ?? allRecords[eventEntity]) : undefined) ?? [];
          const ballotTenureRule = (loaded.domain.relationalRules ?? []).find(
            (r) => r.kind === 'date-window' && r.sourceEntity === outcomeRule.ballotEntity
          );
          const tenureRecords = ballotTenureRule && ballotTenureRule.kind === 'date-window'
            ? (allRecords[ballotTenureRule.windowEntity] ?? parentPool[ballotTenureRule.windowEntity] ?? [])
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
              const parentRecords = allRecords[pFk.targetEntity] ?? parentPool[pFk.targetEntity];
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
            seed: ctx.seed,
            events: eventRecords,
            eligibleActorsOf: (ev) => {
              const scopeId = resolveScopeId(ev);
              return rolePool.getActiveActors(String(ev[eventDateField] ?? releaseDate), scopeId).map((r) => r.actor);
            },
            eventDateOf: (ev) => String(ev[eventDateField] ?? releaseDate),
            streamKey: (ev) => `scopedDecision:${ev['ID'] ?? ev['id']}`,
            rule: outcomeRule.rule ?? 'majority',
            quorum: outcomeRule.quorum,
            tieRule: outcomeRule.tieRule,
            abstainHandling: outcomeRule.abstainHandling,
            abstainRate: outcomeRule.abstainRate,
            categoricalWeights: outcomeRule.categoricalWeights,
            targetApprovalRate,
            createBallot: (_ballotRng, ev, actor, vote, ballotDate) => {
              const decisionId = identityService.MintId(loaded.domain.name, entityName, [String(ev['ID'] ?? ev['id'])]);
              const ballotId = identityService.MintId(loaded.domain.name, outcomeRule.ballotEntity, [decisionId, actor.ID]);
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

          allRecords[outcomeRule.ballotEntity] = ballots;
          bgRecordsByEntity.set(outcomeRule.ballotEntity, ballots);

          backgroundRecords.push(...decisions);
        } else {
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
        }

        for (const row of backgroundRecords) {
          cascadeDependentChildren({
            parentEntity: entityName,
            parentRow: row,
            cycle: asOfYear,
            activeEras: (loaded.erasManifest?.eras ?? []).filter((e) => e.cycles.includes(asOfYear)),
          });
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

  for (const node of executionOrder) {
    const result = await node.execute({
      domain: loaded.domain,
      seed,
      asOfDate: releaseDate,
      generatedData,
    });
    for (const [entity, rows] of Object.entries(result)) {
      generatedData.set(entity, rows);
      if (!allRecords[entity] || allRecords[entity]!.length === 0) {
        allRecords[entity] = rows;
      }
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

      // Spread temporal dates across birthCycle for cohort entities (entities with foreign keys)
      const isCohortEntity = Object.keys(loaded.domain.entities[entityName]?.foreignKeys ?? {}).length > 0;
      const isRelationalRuleEntity = (loaded.domain.relationalRules ?? []).some(
        (r) =>
          (r.kind === 'date-window' && (r.windowEntity === entityName || r.sourceEntity === entityName)) ||
          (r.kind === 'outcome-derived-from-ballots' && (r.sourceEntity === entityName || r.ballotEntity === entityName))
      );
      if (isCohortEntity && !isRelationalRuleEntity) {
        const month = String(1 + (bgIdx % 12)).padStart(2, '0');
        const day = String(1 + (bgIdx % 28)).padStart(2, '0');
        if (r['JoinDate'] !== undefined) {
          filteredFields['JoinDate'] = `${birthCycle}-${month}-${day}`;
          r['JoinDate'] = `${birthCycle}-${month}-${day}`;
        }
        if (r['CreatedAt'] !== undefined) {
          filteredFields['CreatedAt'] = `${birthCycle}-${month}-${day}`;
          r['CreatedAt'] = `${birthCycle}-${month}-${day}`;
        }
        if (r['StartDate'] !== undefined) {
          filteredFields['StartDate'] = `${birthCycle}-${month}-${day}`;
          r['StartDate'] = `${birthCycle}-${month}-${day}`;
        }
      }

      allUnrollCandidates.push({
        id,
        entity: entityName,
        birthCycle: isCohortEntity ? birthCycle : startCycle,
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
        const isCohortEntity = Object.keys(loaded.domain.entities[entityName]?.foreignKeys ?? {}).length > 0;
        const rowYear = isCohortEntity && (row['JoinDate'] || row['CreatedAt'] || row['StartDate'])
          ? new Date(String(row['JoinDate'] ?? row['CreatedAt'] ?? row['StartDate'])).getFullYear()
          : asOfYear;
        const outcomes = state.outcomesByCycle.get(rowYear) ?? state.outcomesByCycle.get(asOfYear);
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
              const isDerivedOutcomeField = (loaded.domain.relationalRules ?? []).some(
                (r) => r.kind === 'outcome-derived-from-ballots' && r.sourceEntity === entityName && r.outcomeField === field
              );
              if (isDerivedOutcomeField) {
                // Invariant: outcome derived strictly from ballots via scopedDecision; do not decouple
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
                  const complement = resolveComplement(
                    targetVal,
                    loaded.domain.entities[entityName]?.fields[field]
                  );
                  if (complement !== undefined) {
                    row[field] = complement;
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
              i: k,
              parentPool: allRecords,
              rng: rowRng,
              identityService,
            });
            childRow[fkFieldName] = parentId;
            childRow['ID'] = identityService.MintId(loaded.domain.name, cr.entity, [parentId, String(c), String(k)]);
            for (const fName of Object.keys(childCfg.fields)) {
              if (fName.endsWith('Number') || fName.endsWith('Code')) {
                const seq = Math.abs(createRng(seed, `seq:${parentId}:${c}:${k}`).int(10000, 99999));
                childRow[fName] = `${fName.slice(0, 3).toUpperCase()}-${c}${seq}`;
              }
            }
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

            // Calibrate factor outcomes on motif-generated child row using contract target
            for (const contract of factorContracts.filter((fc) => fc.effect === cr.entity)) {
              if (contract.outcome && contract.outcome.where) {
                const childDraw = rowRng.next() < contract.target;
                const otherwise = contract.outcome.otherwise;
                for (const [field, targetVal] of Object.entries(contract.outcome.where)) {
                  if (childDraw) {
                    childRow[field] = targetVal;
                  } else {
                    if (typeof targetVal === 'boolean') {
                      childRow[field] = !targetVal;
                    } else if (otherwise && otherwise[field] !== undefined) {
                      childRow[field] = otherwise[field];
                    }
                  }
                }
              }
            }
            if (!allRecords[cr.entity]) {
              allRecords[cr.entity] = [];
            }
            allRecords[cr.entity]!.push(childRow);

            const cascadeRes = cascadeDependentChildren({
              parentEntity: cr.entity,
              parentRow: childRow,
              cycle: c,
              activeEras,
            });
            if (cascadeRes.hasLineChild && cascadeRes.lineCount === 0) {
              allRecords[cr.entity]!.pop();
            }
          }
        }
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
              i: j,
              parentPool: allRecords,
              rng: childRng,
              identityService,
            });
            childRow[fkFieldName] = heroId;
            childRow['ID'] = identityService.MintId(loaded.domain.name, entityName, [heroId, String(j)]);
            for (const fName of Object.keys(entityCfg.fields)) {
              if (fName.endsWith('Number') || fName.endsWith('Code')) {
                const seq = Math.abs(createRng(seed, `seq:${hero.heroKey}:${j}`).int(10000, 99999));
                childRow[fName] = `${fName.slice(0, 3).toUpperCase()}-${asOfYear}${seq}`;
              }
            }
            if (pin.feature.where) {
              for (const [wField, wVal] of Object.entries(pin.feature.where)) {
                childRow[wField] = wVal;
              }
            }
            if (!allRecords[entityName]) allRecords[entityName] = [];
            allRecords[entityName]!.push(childRow);

            cascadeDependentChildren({
              parentEntity: entityName,
              parentRow: childRow,
              cycle: asOfYear,
              activeEras: (loaded.erasManifest?.eras ?? []).filter((e) => e.cycles.includes(asOfYear)),
            });
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
          tenureInCurrentState: state.tenureInCurrentState,
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
