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
            const evalFn = compileRawFeature(factor.outcome);
            const actual = evalFn(heroRecord, ctx);
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
          const candidateCycles = [2021, 2022, 2023, 2024, 2025, 2026];
          const nonEraCycles = candidateCycles.filter((cy) => !allEntityEraCycles.includes(cy));
          let baselineScopedCount = 0;
          let baselineTotalCount = 0;
          let nonEraSamples = 0;
          for (const cy of nonEraCycles) {
            const totalInCy = records.filter((r) => getRowYear(r) === cy).length;
            const scopedInCy = records.filter((r) => {
              const rowYear = getRowYear(r);
              if (rowYear !== undefined && rowYear !== cy) return false;
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
            }).length;
            baselineScopedCount += scopedInCy;
            baselineTotalCount += totalInCy;
            nonEraSamples++;
          }
          const allInEraCycle = records.filter((r) => getRowYear(r) === targetCycle);
          const avgBaselineScoped = nonEraSamples > 0 ? baselineScopedCount / nonEraSamples : matchingInEraCycle.length;
          const avgBaselineTotal = nonEraSamples > 0 ? baselineTotalCount / nonEraSamples : allInEraCycle.length;
          const realizedScoped = matchingInEraCycle.length;
          const realizedTotal = allInEraCycle.length;

          let passed = false;
          let message = '';
          if (vm.where) {
            // Check if parent entity has an active volume multiplier in targetCycle
            let parentMultiplier = 1.0;
            for (const fk of Object.values(entityCfg.foreignKeys ?? {})) {
              if (fk.cardinality === 'required' || (fk as Record<string, unknown>).dependent === true) {
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
            const expectedTotal = effectiveBaselineTotal - effectiveBaselineScoped + (effectiveBaselineScoped * vm.multiplier);
            const relDiffTotal = Math.abs(realizedTotal - expectedTotal) / Math.max(expectedTotal, 1);
            const totalPassed = relDiffTotal <= 0.20;

            if (vm.multiplier === 0) {
              const scopedPassed = realizedScoped === 0;
              passed = scopedPassed && totalPassed;
              message = passed
                ? `Era '${era.eraKey}' realized multiplier 0: 0 rows generated for ${vm.entity} [scoped] and total volume fell by category share to ${realizedTotal} (expected ~${Math.round(expectedTotal)}, diff: ${(relDiffTotal * 100).toFixed(1)}% <= 20%)`
                : `Era '${era.eraKey}' scoped multiplier 0 failed: scoped=${realizedScoped} (expected 0), total=${realizedTotal} (expected ~${Math.round(expectedTotal)}, diff: ${(relDiffTotal * 100).toFixed(1)}%)`;
            } else {
              const expectedScoped = effectiveBaselineScoped * vm.multiplier;
              const relDiffScoped = Math.abs(realizedScoped - expectedScoped) / Math.max(expectedScoped, 1);
              const scopedPassed = relDiffScoped <= 0.20;
              passed = scopedPassed && totalPassed;
              message = passed
                ? `Era '${era.eraKey}' volume conforms to multiplier ${vm.multiplier}x: scoped=${realizedScoped} (~${Math.round(expectedScoped)}), total=${realizedTotal} (~${Math.round(expectedTotal)})`
                : `Era '${era.eraKey}' volume out of tolerance for ${vm.multiplier}x: scoped diff ${(relDiffScoped * 100).toFixed(1)}%, total diff ${(relDiffTotal * 100).toFixed(1)}%`;
            }
          } else {
            // Check if dependent child entity has a scoped multiplier in targetCycle dropping parents
            let childRetentionRate = 1.0;
            for (const [cName, cCfg] of Object.entries(domain.entities)) {
              for (const fk of Object.values(cCfg.foreignKeys ?? {})) {
                if (fk.targetEntity === vm.entity && (fk.cardinality === 'required' || (fk as Record<string, unknown>).dependent === true)) {
                  for (const e of eras) {
                    if (e.cycles.includes(targetCycle)) {
                      for (const cvm of e.volumeMultipliers) {
                        if (cvm.entity === cName && cvm.multiplier === 0 && cvm.where) {
                          childRetentionRate *= 0.5;
                        }
                      }
                    }
                  }
                }
              }
            }

            if (vm.multiplier === 0) {
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

          const refCycles = [2021, 2022, 2023, 2024, 2025, 2026].filter(
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
              : `Era '${era.eraKey}' deltaIntercept ${fa.deltaIntercept} expected downward shift of >= ${minShift} for ${fa.factor} in cycle ${targetCycle}, but observed rate ${rateInCycle.toFixed(4)} vs ref ${avgRefRate.toFixed(4)}`;
          } else {
            passed = rateInCycle >= avgRefRate + minShift;
            message = passed
              ? `Era '${era.eraKey}' deltaIntercept +${fa.deltaIntercept} shifted ${fa.factor} upward in cycle ${targetCycle} (${rateInCycle.toFixed(4)} >= ref ${avgRefRate.toFixed(4)} + ${minShift})`
              : `Era '${era.eraKey}' deltaIntercept +${fa.deltaIntercept} expected upward shift of >= ${minShift} for ${fa.factor} in cycle ${targetCycle}, but observed rate ${rateInCycle.toFixed(4)} vs ref ${avgRefRate.toFixed(4)}`;
          }

          gates.push({
            name: `Realized Era Factor: ${era.eraKey} [${fa.factor} in ${targetCycle}]`,
            category: 'era',
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
            const isDependent = fk.cardinality === 'required' || (fk as Record<string, unknown>).dependent === true;
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
}
