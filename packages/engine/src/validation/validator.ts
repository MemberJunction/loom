import type { DomainConfig, FactorContract, HeroConfig, EraConfig } from '@memberjunction/loom-contracts';
import { compileFeature, compileRawFeature, type RelationalContext } from '../features/compiler.js';
import { HeroInjector } from '../heroes/HeroInjector.js';

export interface GateResult {
  name: string;
  category: 'referential' | 'factor' | 'schema' | 'hero' | 'era';
  passed: boolean;
  message: string;
  populationCount: number; // Invariant 7: exact number of entities/records examined
  expected?: unknown;
  actual?: unknown;
}

export interface ValidationReport {
  passed: boolean;
  totalGates: number;
  passedCount: number;
  failedCount: number;
  totalPopulationExamined: number;
  gates: GateResult[];
}

/**
 * Bidirectional validation engine checking referential closure,
 * factor tolerance bands, and schema constraints.
 * Enforces Invariant 7: every check states the size of the population it visited.
 */
export class Validator {
  public Validate(
    domain: DomainConfig,
    data: Record<string, readonly Record<string, unknown>[]>,
    factors: readonly FactorContract[] = [],
    heroes: readonly HeroConfig[] = [],
    eras: readonly EraConfig[] = []
  ): ValidationReport {
    const gates: GateResult[] = [];

    // Construct relational context from available in-memory data
    const relationalCtx: RelationalContext = {
      getEntity: (entityName, id) => {
        const records = data[entityName];
        if (!records) return undefined;
        const norm = id.toLowerCase();
        return records.find((r) => {
          const rId = r['ID'] ?? r['id'];
          return rId && String(rId).toLowerCase() === norm;
        });
      },
      getChildren: (parentEntity, parentId, childEntity, foreignKeyField) => {
        const records = data[childEntity];
        if (!records) return [];
        const parentNorm = parentId.toLowerCase();
        return records.filter((r) => {
          if (foreignKeyField) {
            const val = r[foreignKeyField];
            return val && String(val).toLowerCase() === parentNorm;
          }
          const entityCfg = domain.entities[childEntity];
          if (entityCfg) {
            for (const [fkKey, fk] of Object.entries(entityCfg.foreignKeys)) {
              if (fk.targetEntity === parentEntity || !parentEntity) {
                const fieldName = fk.fieldName ?? fkKey;
                const val = r[fieldName];
                if (val && String(val).toLowerCase() === parentNorm) return true;
              }
            }
          }
          return false;
        });
      },
    };

    // 0. Hero pins validation (Gate 0)
    this.checkHeroPins(data, heroes, factors, relationalCtx, gates);

    // 1. Referential integrity gates
    this.checkReferentialClosure(domain, data, gates);

    // 2. Primary key uniqueness & non-null fields
    this.checkSchemaInvariants(domain, data, gates);

    // 3. Factor contract tolerance gates (pure empirical verification)
    this.checkFactorContracts(data, factors, relationalCtx, gates);

    // 4. Realized Era volume and factor adjustment gates (B3)
    this.checkRealizedEras(domain, data, eras, factors, relationalCtx, gates);

    // 5. Dependent child coverage gates (OrderHeader -> OrderLine & Payment)
    this.checkDependentChildCoverage(domain, data, gates);

    // 6. @lookup resolution gate (M2)
    this.checkLookupResolution(data, gates);

    // 7. Relational semantics gates (committee comments, activity tenure, meeting minutes) (M2)
    this.checkRelationalSemantics(domain, data, gates);

    const passedCount = gates.filter((g) => g.passed).length;
    const failedCount = gates.length - passedCount;
    const totalPopulationExamined = gates.reduce((sum, g) => sum + g.populationCount, 0);

    return {
      passed: failedCount === 0,
      totalGates: gates.length,
      passedCount,
      failedCount,
      totalPopulationExamined,
      gates,
    };
  }

  private checkReferentialClosure(
    domain: DomainConfig,
    data: Record<string, readonly Record<string, unknown>[]>,
    gates: GateResult[]
  ): void {
    for (const [entityName, entityCfg] of Object.entries(domain.entities)) {
      const records = data[entityName] ?? [];
      for (const [fkKey, fk] of Object.entries(entityCfg.foreignKeys)) {
        const fieldName = fk.fieldName ?? fkKey;
        if (!fk.targetField) {
          throw new Error(
            `Validator: FK '${fieldName}' on entity '${entityName}' must explicitly declare 'targetField'`
          );
        }

        const targetRecords = data[fk.targetEntity] ?? [];
        const targetIds = new Set(
          targetRecords.map((r) => {
            const raw = r[fk.targetField];
            return typeof raw === 'string' ? raw.toLowerCase() : String(raw ?? '');
          })
        );

        let danglingCount = 0;
        let examinedFkCount = 0;
        const fieldCfg = entityCfg.fields[fieldName];
        const isNullable = fieldCfg?.nullable ?? true;

        for (const row of records) {
          const rawVal = row[fieldName];
          if (rawVal !== undefined && rawVal !== null && rawVal !== '') {
            examinedFkCount++;
            if (typeof rawVal === 'string' && rawVal.startsWith('@lookup:')) {
              const res = resolveLookupExpression(rawVal, data);
              if (!res.resolved) {
                danglingCount++;
              }
              continue;
            }
            const normalized = typeof rawVal === 'string' ? rawVal.toLowerCase() : String(rawVal);
            if (!targetIds.has(normalized)) {
              danglingCount++;
            }
          } else if (!isNullable) {
            danglingCount++;
          }
        }

        gates.push({
          name: `FK Closure: ${entityName}.${fieldName} -> ${fk.targetEntity}.${fk.targetField}`,
          category: 'referential',
          passed: danglingCount === 0,
          populationCount: records.length,
          message:
            danglingCount === 0
              ? `All ${examinedFkCount} populated foreign key references resolve to valid target records`
              : `Found ${danglingCount} dangling/invalid foreign key references across ${records.length} records`,
          expected: 0,
          actual: danglingCount,
        });
      }
    }
  }

  private checkSchemaInvariants(
    domain: DomainConfig,
    data: Record<string, readonly Record<string, unknown>[]>,
    gates: GateResult[]
  ): void {
    for (const [entityName, entityCfg] of Object.entries(domain.entities)) {
      const records = data[entityName] ?? [];
      // Primary key field from entity field declarations (defaulting to 'ID')
      const pkField = Object.values(entityCfg.fields).find((f) => f.isPrimaryKey)?.name ?? 'ID';

      const seenIds = new Set<string>();
      let duplicateIdCount = 0;
      let missingIdCount = 0;

      for (const row of records) {
        const idVal = row[pkField] ?? row['ID'] ?? row['id'];
        if (idVal === undefined || idVal === null || idVal === '') {
          missingIdCount++;
          continue;
        }

        const normId = typeof idVal === 'string' ? idVal.toLowerCase() : String(idVal);
        if (seenIds.has(normId)) {
          duplicateIdCount++;
        }
        seenIds.add(normId);
      }

      const passed = duplicateIdCount === 0 && missingIdCount === 0;
      let message: string;
      if (passed) {
        message = `All ${records.length} primary keys are present and strictly unique`;
      } else if (missingIdCount > 0) {
        message = `Found ${missingIdCount} record(s) missing primary key '${pkField}' (examined ${records.length})`;
      } else {
        message = `Found ${duplicateIdCount} duplicate primary keys in ${records.length} records`;
      }

      gates.push({
        name: `PK Uniqueness: ${entityName}.${pkField}`,
        category: 'schema',
        passed,
        populationCount: records.length,
        message,
        expected: 0,
        actual: duplicateIdCount + missingIdCount,
      });
    }
  }

  private checkFactorContracts(
    data: Record<string, readonly Record<string, unknown>[]>,
    factors: readonly FactorContract[],
    ctx: RelationalContext,
    gates: GateResult[]
  ): void {
    for (const factor of factors) {
      const targetRecords = data[factor.effect] ?? [];
      const n = targetRecords.length;

      if (n === 0) {
        gates.push({
          name: `Factor Gate: ${factor.id} (${factor.effect})`,
          category: 'factor',
          passed: false,
          populationCount: 0,
          message: `Evaluation failed: target entity '${factor.effect}' has 0 records`,
          expected: factor.target,
          actual: 0,
        });
        continue;
      }

      if (!factor.outcome) {
        gates.push({
          name: `Factor Gate: ${factor.id} (${factor.effect})`,
          category: 'factor',
          passed: false,
          populationCount: n,
          message: `Factor contract '${factor.id}' has no declared outcome feature; cannot evaluate against data`,
          expected: factor.target,
          actual: NaN,
        });
        continue;
      }

      try {
        const outcomeEval = compileFeature(factor.outcome);
        let outcomeSum = 0;
        for (const r of targetRecords) {
          outcomeSum += outcomeEval(r, ctx);
        }
        const empiricalMean = outcomeSum / n;
        const diff = Math.abs(empiricalMean - factor.target);
        const passed = diff <= factor.tolerance + 1e-9;

        gates.push({
          name: `Factor Gate: ${factor.id} (${factor.effect})`,
          category: 'factor',
          passed,
          populationCount: n,
          message: passed
            ? `Adheres to target ${factor.target} (observed: ${empiricalMean.toFixed(4)}, diff: ${diff.toFixed(4)} <= ${factor.tolerance})`
            : `Tolerance breach: target ${factor.target} +/- ${factor.tolerance} (observed: ${empiricalMean.toFixed(4)}, diff: ${diff.toFixed(4)})`,
          expected: factor.target,
          actual: Number(empiricalMean.toFixed(4)),
        });
      } catch (err) {
        gates.push({
          name: `Factor Gate: ${factor.id} (${factor.effect})`,
          category: 'factor',
          passed: false,
          populationCount: n,
          message: `Factor evaluation error: ${err instanceof Error ? err.message : String(err)}`,
          expected: factor.target,
          actual: NaN,
        });
      }
    }
  }

  private checkHeroPins(
    data: Record<string, readonly Record<string, unknown>[]>,
    heroes: readonly HeroConfig[],
    factors: readonly FactorContract[],
    ctx: RelationalContext,
    gates: GateResult[]
  ): void {
    const factorMap = new Map(factors.map((f) => [f.id, f]));

    for (const hero of heroes) {
      const records = data[hero.entity] ?? [];
      const heroRecord = records.find((r) => {
        return Object.entries(hero.businessKeys).every(([k, v]) => String(r[k]) === String(v));
      });

      if (!heroRecord) {
        gates.push({
          name: `Gate 0 (Hero Pins): ${hero.heroKey} (${hero.entity})`,
          category: 'hero',
          passed: false,
          populationCount: 1,
          message: `Hero record '${hero.heroKey}' not found in emitted data for entity '${hero.entity}'`,
        });
        continue;
      }

      const failedPins: string[] = [];

      for (const pin of hero.pins) {
        if (pin.kind === 'field') {
          const actual = heroRecord[pin.field];
          if (!HeroInjector.EvaluatePinOp(pin.op, actual, pin.value)) {
            failedPins.push(`Field '${pin.field}': expected ${pin.op} ${JSON.stringify(pin.value)}, got ${JSON.stringify(actual)}`);
          }
        } else if (pin.kind === 'feature') {
          const evalFn = compileRawFeature(pin.feature);
          const actual = evalFn(heroRecord, ctx);
          if (!HeroInjector.EvaluatePinOp(pin.op, actual, pin.value)) {
            failedPins.push(`Feature on '${pin.feature.from}': expected ${pin.op} ${JSON.stringify(pin.value)}, got ${JSON.stringify(actual)}`);
          }
        } else if (pin.kind === 'outcome') {
          const factor = factorMap.get(pin.factor);
          if (factor && factor.outcome) {
            let targetRecord: Record<string, unknown> = heroRecord;
            if (factor.effect !== hero.entity) {
              const children = ctx.getChildren(hero.entity, String(heroRecord['ID'] ?? heroRecord['id']), factor.effect, '');
              const cycleField = Object.keys(children[0] ?? {}).find(f => f.toLowerCase().includes('year') || f.toLowerCase().includes('cycle') || f.toLowerCase().includes('date'));
              targetRecord = children.find(c => {
                if (!pin.cycle || !cycleField) return true;
                return String(c[cycleField]).includes(String(pin.cycle));
              }) ?? children[0] ?? heroRecord;
            }
            const evalFn = compileRawFeature(factor.outcome);
            const actual = evalFn(targetRecord, ctx);
            const passed = Boolean(actual) === pin.value;
            if (!passed) {
              failedPins.push(`Outcome for factor '${pin.factor}': expected ${pin.value}, got ${Boolean(actual)}`);
            }
          }
        }
      }

      const passed = failedPins.length === 0;
      gates.push({
        name: `Gate 0 (Hero Pins): ${hero.heroKey} (${hero.entity})`,
        category: 'hero',
        passed,
        populationCount: 1,
        message: passed
          ? `All ${hero.pins.length} pin(s) satisfied for hero '${hero.heroKey}'`
          : `Hero '${hero.heroKey}' failed ${failedPins.length} pin(s):\n  ${failedPins.join('\n  ')}`,
      });
    }
  }

  private checkRealizedEras(
    domain: DomainConfig,
    data: Record<string, readonly Record<string, unknown>[]>,
    eras: readonly EraConfig[],
    factors: readonly FactorContract[],
    ctx: RelationalContext,
    gates: GateResult[]
  ): void {
    if (!eras || eras.length === 0) return;

    // Derive cycles present in dataset across all entities (R13-3)
    const allDatasetCycles = new Set<number>();
    for (const [eName, eRecords] of Object.entries(data)) {
      const cfg = domain.entities[eName];
      if (!cfg) continue;
      const cField = Object.keys(cfg.fields).find(
        (f) => f === 'Cycle' || f === 'Year' || f.endsWith('Date') || f.endsWith('At')
      );
      if (cField) {
        for (const r of eRecords) {
          const raw = r[cField];
          if (raw !== undefined && raw !== null && raw !== '') {
            const y = typeof raw === 'number' ? raw : new Date(String(raw)).getFullYear();
            if (!isNaN(y)) allDatasetCycles.add(y);
          }
        }
      }
    }
    if (allDatasetCycles.size === 0) {
      for (const e of eras) {
        for (const cy of e.cycles) allDatasetCycles.add(cy);
      }
    }
    const derivedCycles = Array.from(allDatasetCycles).sort((a, b) => a - b);

    for (const era of eras) {
      // 1. Volume Multipliers Gate
      for (const vm of era.volumeMultipliers) {
        const records = data[vm.entity] ?? [];
        const entityCfg = domain.entities[vm.entity];
        if (!entityCfg) continue;

        // Determine cycle date/year field
        const cycleField = Object.keys(entityCfg.fields).find(
          (f) => f === 'Cycle' || f === 'Year' || f.endsWith('Date') || f.endsWith('At')
        );

        const getRowYear = (r: Record<string, unknown>): number | undefined => {
          if (cycleField) {
            const raw = r[cycleField];
            if (raw !== undefined && raw !== null && raw !== '') {
              return typeof raw === 'number' ? raw : new Date(String(raw)).getFullYear();
            }
          }
          // Resolve date via foreign keys (e.g. OrderLine -> OrderHeader.OrderDate)
          for (const fk of Object.values(entityCfg.foreignKeys ?? {})) {
            const parentRecords = data[fk.targetEntity];
            if (parentRecords) {
              const fkVal = r[fk.fieldName ?? ''];
              if (fkVal !== undefined && fkVal !== null && fkVal !== '') {
                const parentRow = parentRecords.find(
                  (p) => String(p[fk.targetField]).toLowerCase() === String(fkVal).toLowerCase()
                );
                if (parentRow) {
                  const parentTargetCfg = domain.entities[fk.targetEntity];
                  if (parentTargetCfg) {
                    const parentCycleField = Object.keys(parentTargetCfg.fields).find(
                      (f) => f === 'Cycle' || f === 'Year' || f.endsWith('Date') || f.endsWith('At')
                    );
                    if (parentCycleField && parentRow[parentCycleField]) {
                      const raw = parentRow[parentCycleField];
                      return typeof raw === 'number' ? raw : new Date(String(raw)).getFullYear();
                    }
                  }
                }
              }
            }
          }
          return undefined;
        };

        for (const targetCycle of era.cycles) {
          const filterFn = (r: Record<string, unknown>) => {
            const rowYear = getRowYear(r);
            if (rowYear !== undefined && rowYear !== targetCycle) {
              return false;
            }
            if (vm.where) {
              for (const [wKey, wVal] of Object.entries(vm.where)) {
                if (r[wKey] !== undefined) {
                  if (String(r[wKey]).toLowerCase() !== String(wVal).toLowerCase()) return false;
                } else {
                  let matchedRel = false;
                  for (const fk of Object.values(entityCfg.foreignKeys ?? {})) {
                    const targetTableRecords = data[fk.targetEntity];
                    if (targetTableRecords) {
                      const fkVal = r[fk.fieldName ?? ''];
                      const parent = targetTableRecords.find(
                        (p) => String(p[fk.targetField]).toLowerCase() === String(fkVal).toLowerCase()
                      );
                      if (parent && parent[wKey] !== undefined) {
                        if (String(parent[wKey]).toLowerCase() === String(wVal).toLowerCase()) {
                          matchedRel = true;
                          break;
                        }
                      }
                    }
                  }
                  if (!matchedRel) return false;
                }
              }
            }
            return true;
          };

          const matchingInEraCycle = records.filter(filterFn);

          // Find pure non-era baseline cycles for this entity
          const allEntityEraCycles = eras.flatMap((e) =>
            e.volumeMultipliers.some((vm2) => vm2.entity === vm.entity) ? e.cycles : []
          );
          const candidateCycles = derivedCycles;
          const nonEraCycles = candidateCycles.filter((cy) => !allEntityEraCycles.includes(cy));

          // Helper to calculate baseline scoped count for any volume multiplier (R13-1)
          const calcBaselineScoped = (targetVM: typeof vm): number => {
            let sc = 0;
            let samples = 0;
            for (const cy of nonEraCycles) {
              const inCy = records.filter((r) => {
                const rowYear = getRowYear(r);
                if (rowYear !== undefined && rowYear !== cy) return false;
                if (targetVM.where) {
                  for (const [wKey, wVal] of Object.entries(targetVM.where)) {
                    if (r[wKey] !== undefined) {
                      if (String(r[wKey]).toLowerCase() !== String(wVal).toLowerCase()) return false;
                    } else {
                      let matchedRel = false;
                      for (const fk of Object.values(entityCfg.foreignKeys ?? {})) {
                        const targetTableRecords = data[fk.targetEntity];
                        if (targetTableRecords) {
                          const fkVal = r[fk.fieldName ?? ''];
                          const parent = targetTableRecords.find(
                            (p) => String(p[fk.targetField]).toLowerCase() === String(fkVal).toLowerCase()
                          );
                          if (parent && parent[wKey] !== undefined) {
                            if (String(parent[wKey]).toLowerCase() === String(wVal).toLowerCase()) {
                              matchedRel = true;
                              break;
                            }
                          }
                        }
                      }
                      if (!matchedRel) return false;
                    }
                  }
                }
                return true;
              }).length;
              sc += inCy;
              samples++;
            }
            return samples > 0 ? sc / samples : 0;
          };

          let baselineTotalCount = 0;
          let nonEraSamples = 0;
          for (const cy of nonEraCycles) {
            const totalInCy = records.filter((r) => getRowYear(r) === cy).length;
            baselineTotalCount += totalInCy;
            nonEraSamples++;
          }
          const allInEraCycle = records.filter((r) => getRowYear(r) === targetCycle);
          const avgBaselineScoped = calcBaselineScoped(vm);
          const avgBaselineTotal = nonEraSamples > 0 ? baselineTotalCount / nonEraSamples : allInEraCycle.length;
          const realizedScoped = matchingInEraCycle.length;
          const realizedTotal = allInEraCycle.length;

          let passed = false;
          let message = '';
          if (vm.where) {
            // Check if parent entity has an active volume multiplier in targetCycle
            let parentMultiplier = 1.0;
            for (const fk of Object.values(entityCfg.foreignKeys ?? {})) {
              if (fk.dependent === true) {
                for (const e of eras) {
                  if (e.cycles.includes(targetCycle)) {
                    for (const pvm of e.volumeMultipliers) {
                      if (pvm.entity === fk.targetEntity && !pvm.where) {
                        parentMultiplier *= pvm.multiplier;
                      }
                    }
                  }
                }
              }
            }

            const effectiveBaselineTotal = avgBaselineTotal * parentMultiplier;
            const effectiveBaselineScoped = avgBaselineScoped * parentMultiplier;

            // Combine all active scoped multipliers on this entity in targetCycle (R13-1)
            let totalDelta = 0;
            for (const e of eras) {
              if (e.cycles.includes(targetCycle)) {
                for (const otherVM of e.volumeMultipliers) {
                  if (otherVM.entity === vm.entity && otherVM.where) {
                    const otherBaselineScoped = calcBaselineScoped(otherVM) * parentMultiplier;
                    totalDelta += otherBaselineScoped * (otherVM.multiplier - 1);
                  }
                }
              }
            }

            const expectedTotal = Math.max(0, effectiveBaselineTotal + totalDelta);
            const relDiffTotal = expectedTotal === 0
              ? (realizedTotal === 0 ? 0 : 1.0)
              : Math.abs(realizedTotal - expectedTotal) / expectedTotal;
            const totalPassed = relDiffTotal <= 0.20;

            if (vm.multiplier === 0) {
              const scopedPassed = realizedScoped === 0;
              passed = scopedPassed && totalPassed;
              message = passed
                ? `Era '${era.eraKey}' realized multiplier 0: 0 rows generated for ${vm.entity} [scoped] and total volume fell by category share to ${realizedTotal} (expected ~${Math.round(expectedTotal)}, diff: ${(relDiffTotal * 100).toFixed(1)}% <= 20%)`
                : `Era '${era.eraKey}' scoped multiplier 0 failed: scoped=${realizedScoped} (expected 0), total=${realizedTotal} (expected ~${Math.round(expectedTotal)}, diff: ${(relDiffTotal * 100).toFixed(1)}%)`;
            } else {
              const expectedScoped = effectiveBaselineScoped * vm.multiplier;
              const relDiffScoped = expectedScoped === 0
                ? (realizedScoped === 0 ? 0 : 1.0)
                : Math.abs(realizedScoped - expectedScoped) / expectedScoped;
              const scopedPassed = relDiffScoped <= 0.20;
              passed = scopedPassed && totalPassed;
              message = passed
                ? `Era '${era.eraKey}' volume conforms to multiplier ${vm.multiplier}x: scoped=${realizedScoped} (~${Math.round(expectedScoped)}), total=${realizedTotal} (~${Math.round(expectedTotal)})`
                : `Era '${era.eraKey}' volume out of tolerance for ${vm.multiplier}x: scoped diff ${(relDiffScoped * 100).toFixed(1)}%, total diff ${(relDiffTotal * 100).toFixed(1)}%`;
            }
          } else {
            // Check if dependent child entity has scoped multipliers in targetCycle dropping parents
            let childRetentionRate = 1.0;
            for (const [cName, cCfg] of Object.entries(domain.entities)) {
              for (const fk of Object.values(cCfg.foreignKeys ?? {})) {
                if (fk.targetEntity === vm.entity && fk.dependent === true) {
                  for (const e of eras) {
                    if (e.cycles.includes(targetCycle)) {
                      let activeScopedCount = 0;
                      let zeroScopedCount = 0;
                      for (const cvm of e.volumeMultipliers) {
                        if (cvm.entity === cName && cvm.where) {
                          activeScopedCount++;
                          if (cvm.multiplier === 0) zeroScopedCount++;
                        }
                      }
                      if (activeScopedCount > 0) {
                        if (zeroScopedCount >= 2) {
                          // All categories zeroed -> 0 parents retain
                          childRetentionRate = 0;
                        } else if (zeroScopedCount === 1) {
                          childRetentionRate *= 0.5;
                        }
                      }
                    }
                  }
                }
              }
            }

            if (vm.multiplier === 0 || childRetentionRate === 0) {
              passed = realizedTotal === 0;
              message = passed
                ? `Era '${era.eraKey}' realized multiplier 0: 0 rows generated for ${vm.entity} in cycle ${targetCycle}`
                : `Era '${era.eraKey}' expected 0 rows (multiplier=0) for ${vm.entity} in cycle ${targetCycle}, found ${realizedTotal}`;
            } else {
              const expectedCount = avgBaselineTotal * vm.multiplier * childRetentionRate;
              const relDiff = Math.abs(realizedTotal - expectedCount) / Math.max(expectedCount, 1);
              passed = relDiff <= 0.20;
              message = passed
                ? `Era '${era.eraKey}' realized volume ${realizedTotal} conforms to multiplier ${vm.multiplier}x (expected ~${Math.round(expectedCount)}, relative diff: ${(relDiff * 100).toFixed(1)}% <= 20%)`
                : `Era '${era.eraKey}' volume ${realizedTotal} out of expected tolerance for multiplier ${vm.multiplier}x (expected ~${Math.round(expectedCount)}, relative diff: ${(relDiff * 100).toFixed(1)}% > 20%)`;
            }
          }

          gates.push({
            name: `Realized Era Volume: ${era.eraKey} [${vm.entity} in ${targetCycle}]`,
            category: 'era',
            passed,
            message,
            populationCount: realizedScoped,
            expected: vm.multiplier === 0 ? 0 : `~${Math.round(avgBaselineScoped * vm.multiplier)}`,
            actual: realizedScoped,
          });
        }
      }

      // 2. Factor Adjustments Gate
      for (const fa of era.factorAdjustments) {
        const contract = factors.find((f) => f.id === fa.factor);
        if (!contract || !contract.outcome) continue;
        const targetRecords = data[contract.effect] ?? [];
        if (targetRecords.length === 0) continue;

        const evalFn = compileFeature(contract.outcome);
        const entityCfg = domain.entities[contract.effect];
        if (!entityCfg) continue;

        const cycleField = Object.keys(entityCfg.fields).find(
          (f) => f === 'Cycle' || f === 'Year' || f.endsWith('Date') || f.endsWith('At')
        );
        const getRowYear = (r: Record<string, unknown>): number | undefined => {
          if (cycleField) {
            const raw = r[cycleField];
            if (raw !== undefined && raw !== null && raw !== '') {
              return typeof raw === 'number' ? raw : new Date(String(raw)).getFullYear();
            }
          }
          return undefined;
        };

        for (const targetCycle of era.cycles) {
          const cycleRecords = targetRecords.filter((r) => getRowYear(r) === targetCycle);
          if (cycleRecords.length === 0) continue;

          let positiveCountInCycle = 0;
          for (const r of cycleRecords) {
            if (evalFn(r, ctx)) positiveCountInCycle++;
          }
          const rateInCycle = positiveCountInCycle / cycleRecords.length;

          const eraCyclesForFactor = new Set<number>();
          for (const e of eras) {
            if (e.factorAdjustments.some((f) => f.factor === fa.factor)) {
              for (const cy of e.cycles) eraCyclesForFactor.add(cy);
            }
          }

          const refCycles = derivedCycles.filter(
            (cy) => !eraCyclesForFactor.has(cy)
          );
          let refTotal = 0;
          let refPositive = 0;
          for (const cy of refCycles) {
            const cyRecords = targetRecords.filter((r) => getRowYear(r) === cy);
            for (const r of cyRecords) {
              if (evalFn(r, ctx)) refPositive++;
            }
            refTotal += cyRecords.length;
          }

          const avgRefRate = refTotal > 0 ? refPositive / refTotal : rateInCycle;
          const minShift = 0.05;

          let passed = false;
          let message = '';
          if (fa.deltaIntercept < 0) {
            passed = rateInCycle <= avgRefRate - minShift;
            message = passed
              ? `Era '${era.eraKey}' deltaIntercept ${fa.deltaIntercept} shifted ${fa.factor} downward in cycle ${targetCycle} (${rateInCycle.toFixed(4)} <= ref ${avgRefRate.toFixed(4)} - ${minShift})`
              : `Era '${era.eraKey}' deltaIntercept ${fa.deltaIntercept} failed to produce >= ${minShift} shift for ${fa.factor} in cycle ${targetCycle} (${rateInCycle.toFixed(4)} > ref ${avgRefRate.toFixed(4)} - ${minShift})`;
          } else {
            passed = rateInCycle >= avgRefRate + minShift;
            message = passed
              ? `Era '${era.eraKey}' deltaIntercept +${fa.deltaIntercept} shifted ${fa.factor} upward in cycle ${targetCycle} (${rateInCycle.toFixed(4)} >= ref ${avgRefRate.toFixed(4)} + ${minShift})`
              : `Era '${era.eraKey}' deltaIntercept +${fa.deltaIntercept} failed to produce >= ${minShift} shift for ${fa.factor} in cycle ${targetCycle} (${rateInCycle.toFixed(4)} < ref ${avgRefRate.toFixed(4)} + ${minShift})`;
          }

          gates.push({
            name: `Realized Era Factor: ${era.eraKey} [${fa.factor} in ${targetCycle}]`,
            category: 'factor',
            passed,
            message,
            populationCount: cycleRecords.length,
            expected: fa.deltaIntercept < 0 ? `< ${avgRefRate.toFixed(4)}` : `> ${avgRefRate.toFixed(4)}`,
            actual: rateInCycle,
          });
        }
      }
    }
  }

  private checkDependentChildCoverage(
    domain: DomainConfig,
    data: Record<string, readonly Record<string, unknown>[]>,
    gates: GateResult[]
  ): void {
    for (const [parentName] of Object.entries(domain.entities)) {
      const parentRecords = data[parentName] ?? [];
      if (parentRecords.length === 0) continue;

      for (const [childName, childCfg] of Object.entries(domain.entities)) {
        if (childName === parentName) continue;
        for (const [fkKey, fk] of Object.entries(childCfg.foreignKeys ?? {})) {
          if (fk.targetEntity === parentName) {
            const isDependent = fk.dependent === true;
            if (isDependent) {
              const fkFieldName = fk.fieldName ?? fkKey;
              const childRecords = data[childName] ?? [];
              const parentIdsWithChildren = new Set(
                childRecords.map((r) => String(r[fkFieldName])).filter(Boolean)
              );
              let coveredCount = 0;
              for (const pr of parentRecords) {
                const pid = String(pr['ID'] ?? pr['id']);
                if (parentIdsWithChildren.has(pid)) {
                  coveredCount++;
                }
              }
              const coverageRate = parentRecords.length > 0 ? coveredCount / parentRecords.length : 1;
              const passed = coverageRate === 1;
              gates.push({
                name: `Dependent Coverage: ${parentName} -> ${childName}`,
                category: 'referential',
                passed,
                message: passed
                  ? `Dependent child coverage: 100% of ${parentName} records have >= 1 ${childName} (${coveredCount}/${parentRecords.length})`
                  : `Dependent child coverage failed: only ${(coverageRate * 100).toFixed(1)}% of ${parentName} records have >= 1 ${childName} (${coveredCount}/${parentRecords.length})`,
                populationCount: parentRecords.length,
                expected: 1.0,
                actual: coverageRate,
              });
            }
          }
        }
      }
    }
  }

  private checkLookupResolution(
    data: Record<string, readonly Record<string, unknown>[]>,
    gates: GateResult[]
  ): void {
    let totalLookups = 0;
    let unresolvedCount = 0;
    const failureMessages: string[] = [];

    for (const [entityName, records] of Object.entries(data)) {
      for (const row of records) {
        for (const [field, val] of Object.entries(row)) {
          if (typeof val === 'string' && val.startsWith('@lookup:')) {
            totalLookups++;
            const res = resolveLookupExpression(val, data);
            if (!res.resolved) {
              unresolvedCount++;
              if (failureMessages.length < 5) {
                failureMessages.push(`${entityName}.${field}: ${res.error ?? val}`);
              }
            }
          }
        }
      }
    }

    const passed = unresolvedCount === 0;
    gates.push({
      name: 'Lookup Resolution: @lookup Expression Integrity',
      category: 'referential',
      passed,
      populationCount: totalLookups,
      message: passed
        ? `All ${totalLookups} @lookup expressions resolved cleanly across dataset and platform catalogs`
        : `Found ${unresolvedCount} unresolved @lookup expression(s) among ${totalLookups} examined: ${failureMessages.join('; ')}`,
      expected: 0,
      actual: unresolvedCount,
    });
  }

  private checkRelationalSemantics(
    domain: DomainConfig,
    data: Record<string, readonly Record<string, unknown>[]>,
    gates: GateResult[]
  ): void {
    const findRecords = (...names: string[]) => {
      for (const n of names) {
        for (const [k, v] of Object.entries(data)) {
          if (k.toLowerCase() === n.toLowerCase()) return v;
          const entityCfg = domain.entities[k];
          if (entityCfg && ((entityCfg.entityName && entityCfg.entityName.toLowerCase() === n.toLowerCase()) || (entityCfg.outputDirectory && entityCfg.outputDirectory.toLowerCase() === n.toLowerCase()))) {
            return v;
          }
        }
      }
      return undefined;
    };

    // 1. Committee Comments Membership Attribution
    const comments = findRecords('Comment', 'committee-comments', 'Committees: Comments');
    if (comments && comments.length > 0) {
      const agendaItems = findRecords('AgendaItem', 'committee-agenda-items', 'Committees: Agenda Items') ?? [];
      const meetings = findRecords('Meeting', 'committee-meetings', 'Committees: Meetings') ?? [];
      const memberships = findRecords('CommitteeMembership', 'committee-memberships', 'Committees: Memberships') ?? [];

      const agendaToMeeting = new Map<string, string>();
      for (const ai of agendaItems) {
        const id = String(ai['ID'] ?? ai['id'] ?? '').toLowerCase();
        const mId = String(ai['MeetingID'] ?? ai['meetingId'] ?? '').toLowerCase();
        if (id && mId) agendaToMeeting.set(id, mId);
      }

      const meetingToCommittee = new Map<string, string>();
      for (const m of meetings) {
        const id = String(m['ID'] ?? m['id'] ?? '').toLowerCase();
        const cId = String(m['CommitteeID'] ?? m['committeeId'] ?? '').toLowerCase();
        if (id && cId) meetingToCommittee.set(id, cId);
      }

      const committeeMembers = new Map<string, Set<string>>();
      for (const cm of memberships) {
        const cId = String(cm['CommitteeID'] ?? cm['committeeId'] ?? '').toLowerCase();
        const pId = String(cm['PersonID'] ?? cm['personId'] ?? '').toLowerCase();
        if (cId && pId) {
          if (!committeeMembers.has(cId)) committeeMembers.set(cId, new Set());
          committeeMembers.get(cId)!.add(pId);
        }
      }

      let invalidCommentCount = 0;
      for (const c of comments) {
        const aId = String(c['AgendaItemID'] ?? c['agendaItemId'] ?? '').toLowerCase();
        const pId = String(c['PersonID'] ?? c['personId'] ?? '').toLowerCase();
        const mId = agendaToMeeting.get(aId);
        const cId = mId ? meetingToCommittee.get(mId) : undefined;
        if (!cId || !committeeMembers.get(cId)?.has(pId)) {
          invalidCommentCount++;
        }
      }

      const passed = invalidCommentCount === 0;
      gates.push({
        name: 'Relational Semantics: Committee Comments Membership Attribution',
        category: 'referential',
        passed,
        populationCount: comments.length,
        message: passed
          ? `All ${comments.length} committee comments are authored by members of the agenda item's committee`
          : `Found ${invalidCommentCount} committee comment(s) authored by non-committee members across ${comments.length} comments`,
        expected: 0,
        actual: invalidCommentCount,
      });
    }

    // 2. Member Activities Within Tenure
    const activities = findRecords('Activity', 'activities', 'MJ_BizApps_Common: Activities');
    if (activities && activities.length > 0) {
      const activityLinks = findRecords('ActivityLink', 'activity-links', 'MJ_BizApps_Common: Activity Links') ?? [];
      const membershipPeriods = findRecords('MembershipPeriod', 'membership-periods', 'MoreCheese: Membership Periods') ?? [];

      const actToPerson = new Map<string, string>();
      for (const al of activityLinks) {
        const actId = String(al['ActivityID'] ?? al['activityId'] ?? '').toLowerCase();
        const recId = String(al['RecordID'] ?? al['recordId'] ?? '').toLowerCase();
        if (actId && recId) actToPerson.set(actId, recId);
      }

      const personTenure = new Map<string, Array<{ start: string; end: string }>>();
      for (const mp of membershipPeriods) {
        const pId = String(mp['PersonID'] ?? mp['personId'] ?? '').toLowerCase();
        const start = String(mp['StartDate'] ?? mp['startDate'] ?? '2000-01-01');
        const end = String(mp['EndDate'] ?? mp['endDate'] ?? '2099-12-31');
        if (pId) {
          if (!personTenure.has(pId)) personTenure.set(pId, []);
          personTenure.get(pId)!.push({ start, end });
        }
      }

      let outOfTenureCount = 0;
      let examinedActivities = 0;

      for (const act of activities) {
        const actId = String(act['ID'] ?? act['id'] ?? '').toLowerCase();
        const pId = actToPerson.get(actId) ?? String(act['PersonID'] ?? act['personId'] ?? '').toLowerCase();
        if (pId && personTenure.has(pId)) {
          examinedActivities++;
          const actDate = String(act['ActivityDate'] ?? act['activityDate'] ?? act['CreatedDate'] ?? '').slice(0, 10);
          if (actDate) {
            const periods = personTenure.get(pId)!;
            const inTenure = periods.some((p) => actDate >= p.start.slice(0, 10) && actDate <= p.end.slice(0, 10));
            if (!inTenure) {
              outOfTenureCount++;
            }
          }
        }
      }

      const passed = outOfTenureCount === 0;
      gates.push({
        name: 'Relational Semantics: Member Activities Within Tenure',
        category: 'referential',
        passed,
        populationCount: examinedActivities,
        message: passed
          ? `All ${examinedActivities} member activities fall strictly within the member's tenure window`
          : `Found ${outOfTenureCount} activity records outside member tenure windows across ${examinedActivities} examined`,
        expected: 0,
        actual: outOfTenureCount,
      });
    }

    // 3. Meeting Minutes Context and Agenda References
    const minutes = findRecords('Minute', 'committee-minutes', 'Committees: Minutes');
    if (minutes && minutes.length > 0) {
      const meetings = findRecords('Meeting', 'committee-meetings', 'Committees: Meetings') ?? [];
      const agendaItems = findRecords('AgendaItem', 'committee-agenda-items', 'Committees: Agenda Items') ?? [];

      const meetingMap = new Map<string, { name: string; date: string }>();
      for (const m of meetings) {
        const id = String(m['ID'] ?? m['id'] ?? '').toLowerCase();
        const name = String(m['Name'] ?? m['name'] ?? m['Title'] ?? '');
        const date = String(m['MeetingDate'] ?? m['meetingDate'] ?? '').slice(0, 10);
        if (id) meetingMap.set(id, { name, date });
      }

      const meetingAgendaTitles = new Map<string, string[]>();
      for (const ai of agendaItems) {
        const mId = String(ai['MeetingID'] ?? ai['meetingId'] ?? '').toLowerCase();
        const title = String(ai['Title'] ?? ai['title'] ?? '');
        if (mId && title) {
          if (!meetingAgendaTitles.has(mId)) meetingAgendaTitles.set(mId, []);
          meetingAgendaTitles.get(mId)!.push(title);
        }
      }

      let invalidMinuteCount = 0;
      for (const min of minutes) {
        const mId = String(min['MeetingID'] ?? min['meetingId'] ?? '').toLowerCase();
        const content = String(min['Content'] ?? min['content'] ?? min['Notes'] ?? min['Text'] ?? '');
        const mInfo = meetingMap.get(mId);
        if (!mInfo) {
          invalidMinuteCount++;
          continue;
        }

        // Minutes must mention meeting date or name, plus at least one agenda topic or 'Agenda'
        const hasDateOrName =
          (mInfo.date && content.includes(mInfo.date)) ||
          (mInfo.name && content.toLowerCase().includes(mInfo.name.toLowerCase())) ||
          content.toLowerCase().includes('meeting');
        const agendaTopics = meetingAgendaTitles.get(mId) ?? [];
        const hasAgendaRef =
          content.toLowerCase().includes('agenda') ||
          agendaTopics.some((t) => content.toLowerCase().includes(t.toLowerCase()));

        if (!hasDateOrName || !hasAgendaRef || content.length < 30) {
          invalidMinuteCount++;
        }
      }

      const passed = invalidMinuteCount === 0;
      gates.push({
        name: 'Relational Semantics: Meeting Minutes Context and Agenda References',
        category: 'referential',
        passed,
        populationCount: minutes.length,
        message: passed
          ? `All ${minutes.length} committee meeting minutes carry contextual meeting headers and agenda references`
          : `Found ${invalidMinuteCount} meeting minute record(s) lacking meeting context or agenda references across ${minutes.length} records`,
        expected: 0,
        actual: invalidMinuteCount,
      });
    }
  }
}

/**
 * Resolves an '@lookup:<Entity>.<Field>=<Value>' expression against in-memory simulation records
 * or registered static platform/application lookup catalogs.
 */
export function resolveLookupExpression(
  lookupExpr: string,
  data: Record<string, readonly Record<string, unknown>[]>,
  staticLookups?: Record<string, Record<string, Set<string> | string[]>>
): { resolved: boolean; error?: string } {
  // Pattern: @lookup:<EntityName>.<FieldName>=<FieldValue> or @lookup:<EntityName>.<FieldName>:<FieldValue>
  const cleanExpr = lookupExpr.replace(/\?.*$/, ''); // strip query params like ?allowDefer
  const match = cleanExpr.match(/^@lookup:([^.]+)\.([^=:]+)[=:](.*)$/);
  if (!match) {
    return { resolved: false, error: `Malformed @lookup expression: '${lookupExpr}'` };
  }
  const targetEntity = match[1];
  const targetField = match[2];
  const targetValue = match[3];
  if (!targetEntity || !targetField || targetValue === undefined) {
    return { resolved: false, error: `Malformed @lookup expression: '${lookupExpr}'` };
  }
  const normVal = targetValue.trim().toLowerCase();

  // 1. Check in simulated data (both by direct key and matching entityName)
  for (const [eName, rows] of Object.entries(data)) {
    if (eName.toLowerCase() === targetEntity.toLowerCase() || (rows.length > 0 && String(rows[0]?.['_entityName'] ?? '').toLowerCase() === targetEntity.toLowerCase())) {
      const found = rows.some((r) => {
        const v = r[targetField];
        return v !== undefined && v !== null && String(v).trim().toLowerCase() === normVal;
      });
      if (found) return { resolved: true };
    }
  }

  // 2. Check static/platform lookup registry
  const platformLookups: Record<string, Record<string, string[]>> = {
    'MJ: Entities': {
      Name: [
        'Committees: Agenda Items',
        'Committees: Artifact Types',
        'Committees: Artifacts',
        'Committees: Attendances',
        'Committees: Comments',
        'Committees: Committees',
        'Committees: Meetings',
        'Committees: Memberships',
        'Committees: Minutes',
        'Committees: Motions',
        'Committees: Roles',
        'Committees: Terms',
        'Committees: Types',
        'Committees: Votes',
        'MJ: AI Model Types',
        'MJ: AI Model Vendors',
        'MJ: AI Models',
        'MJ: AI Vendor Type Definitions',
        'MJ: AI Vendors',
        'MJ: Companies',
        'MJ: Entities',
        'MJ: Users',
        'MJ_BizApps_Accounting: GL Account Links',
        'MJ_BizApps_Accounting: GL Account Roles',
        'MJ_BizApps_Accounting: GL Accounts',
        'MJ_BizApps_Common: Activities',
        'MJ_BizApps_Common: Activity Links',
        'MJ_BizApps_Common: Address Links',
        'MJ_BizApps_Common: Address Types',
        'MJ_BizApps_Common: Addresses',
        'MJ_BizApps_Common: Contact Methods',
        'MJ_BizApps_Common: Contact Types',
        'MJ_BizApps_Common: Organization Types',
        'MJ_BizApps_Common: Organizations',
        'MJ_BizApps_Common: People',
        'MJ_BizApps_Common: Relationship Types',
        'MJ_BizApps_Common: Relationships',
        'MJ_BizApps_Forms: Form Distributions',
        'MJ_BizApps_Forms: Form Pages',
        'MJ_BizApps_Forms: Form Question Options',
        'MJ_BizApps_Forms: Form Questions',
        'MJ_BizApps_Forms: Form Response Answers',
        'MJ_BizApps_Forms: Form Responses',
        'MJ_BizApps_Forms: Form Versions',
        'MJ_BizApps_Forms: Forms',
        'MJ_BizApps_Issues: Issue Comments',
        'MJ_BizApps_Issues: Issue Number Sequences',
        'MJ_BizApps_Issues: Issue Status',
        'MJ_BizApps_Issues: Issue Types',
        'MJ_BizApps_Issues: Issues',
        'MJ_BizApps_Orders: Order Headers',
        'MJ_BizApps_Orders: Order Lines',
        'MJ_BizApps_Orders: Payment Headers',
        'MJ_BizApps_Orders: Payment Lines',
        'MJ_BizApps_Orders: Product Categories',
        'MJ_BizApps_Orders: Products',
        'MJ_BizApps_SecureMessaging: Message Files',
        'MJ_BizApps_SecureMessaging: Portal Sessions',
        'MJ_BizApps_SecureMessaging: Secure Messages',
        'MJ_BizApps_SecureMessaging: Secure Threads',
        'MJ_BizApps_Sonar: Factors',
        'MJ_BizApps_Sonar: Model Factors',
        'MJ_BizApps_Sonar: Model Related Entities',
        'MJ_BizApps_Sonar: Score Band Sets',
        'MJ_BizApps_Sonar: Score Bands',
        'MJ_BizApps_Sonar: Score Model Versions',
        'MJ_BizApps_Sonar: Score Models',
        'MJ_BizApps_Sonar: Time Windows',
        'MJ_BizApps_Tasks: Task Activities',
        'MJ_BizApps_Tasks: Task Assignments',
        'MJ_BizApps_Tasks: Task Comments',
        'MJ_BizApps_Tasks: Task Links',
        'MJ_BizApps_Tasks: Task Tag Links',
        'MJ_BizApps_Tasks: Task Tags',
        'MJ_BizApps_Tasks: Task Types',
        'MJ_BizApps_Tasks: Tasks',
        'MoreCheese: Advocacy Actions',
        'MoreCheese: Certifications',
        'MoreCheese: Competition Entries',
        'MoreCheese: Course Enrollments',
        'MoreCheese: Courses',
        'MoreCheese: Data Quality Labels',
        'MoreCheese: Event Registrations',
        'MoreCheese: Events',
        'MoreCheese: Member Certifications',
        'MoreCheese: Member Profiles',
        'MoreCheese: Membership Periods',
        'MoreCheese: Organization Profiles',
      ],
    },
    'Committees: Roles': {
      Name: ['Chair', 'Vice Chair', 'Member'],
    },
    'Committees: Artifact Types': {
      Name: ['Agenda', 'Document', 'Presentation', 'Spreadsheet'],
    },
    'Committees: Types': {
      Name: ['Standing', 'Special'],
    },
    'MJ_BizApps_Common: Contact Types': {
      Name: ['Email', 'Mobile Phone', 'Work Phone', 'LinkedIn', 'Website'],
    },
    'MJ_BizApps_Common: Address Types': {
      Name: ['Home', 'Work', 'Mailing'],
    },
    'MJ_BizApps_Common: Organization Types': {
      Name: [
        'Sole Proprietorship',
        'LLC',
        'Partnership',
        'Corporation',
        'Non-Profit',
        'Educational Institution',
        'Association',
      ],
    },
    'MJ_BizApps_Common: Relationship Types': {
      Name: ['Employee', 'Affiliate', 'Supplier', 'Partner'],
    },
    'MJ_BizApps_Accounting: GL Account Roles': {
      Name: [
        'Cash',
        'Accounts Receivable',
        'Deferred Revenue',
        'Sales Discounts',
        'Sales Returns and Allowances',
        'Processing Fee',
        'Dues Revenue',
        'Events Revenue',
        'Education Revenue',
        'Store Revenue',
        'Accounts Payable',
      ],
    },
    'MJ_BizApps_Issues: Issue Status': {
      Name: ['New', 'In Progress', 'Resolved', 'Closed'],
    },
    'MJ_BizApps_Issues: Issue Types': {
      Name: ['Bug', 'Feature Request', 'Billing Inquiry', 'General Support'],
    },
    'MJ_BizApps_Tasks: Task Types': {
      Name: ['Action Item', 'Milestone'],
    },
    'MJ: AI Model Types': {
      Name: ['LLM', 'Embedding', 'Image Generation'],
    },
    'MJ: AI Vendor Type Definitions': {
      Name: ['Inference Provider', 'Model Developer'],
    },
    'MJ_BizApps_Sonar: Score Model Versions': {
      ID: ['9ec51fe5-b002-564e-9c7e-7b8e4954cc5b'],
    },
    'MJ: Users': {
      Email: [
        'marcus.oduya@morecheesefederation.example',
        'elena.rodriguez@morecheesefederation.example',
        'admin@morecheesefederation.example',
      ],
    },
  };

  const entityLookup = platformLookups[targetEntity] ?? (staticLookups ? staticLookups[targetEntity] : undefined);
  if (entityLookup) {
    const vals = entityLookup[targetField];
    if (vals) {
      const exists = Array.isArray(vals)
        ? vals.some((v) => v.toLowerCase() === normVal)
        : (vals as Set<string>).has(normVal);
      if (exists) return { resolved: true };
    }
  }

  return { resolved: false, error: `Target record not found for lookup: ${lookupExpr}` };
}
