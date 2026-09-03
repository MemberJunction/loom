import type { DomainConfig, FactorContract, HeroConfig } from '@memberjunction/loom-contracts';
import { compileFeature, compileRawFeature, type RelationalContext } from '../features/compiler.js';
import { HeroInjector } from '../heroes/HeroInjector.js';

export interface GateResult {
  name: string;
  category: 'referential' | 'factor' | 'schema' | 'hero';
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
    heroes: readonly HeroConfig[] = []
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
        const passed = diff <= factor.tolerance;

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
}
