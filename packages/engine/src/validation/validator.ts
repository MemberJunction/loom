import type { DomainConfig, FactorContract } from '@memberjunction/loom-contracts';
import { compileFeature } from '../features/compiler.js';
import { sigmoid } from '../math/calibration.js';

export interface GateResult {
  name: string;
  category: 'referential' | 'factor' | 'schema';
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
    factors: readonly FactorContract[] = []
  ): ValidationReport {
    const gates: GateResult[] = [];

    // 1. Referential integrity gates
    this.checkReferentialClosure(domain, data, gates);

    // 2. Primary key uniqueness & non-null fields
    this.checkSchemaInvariants(domain, data, gates);

    // 3. Factor contract tolerance gates (empirical verification)
    this.checkFactorContracts(data, factors, gates);

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
  public validate(
    domain: DomainConfig,
    data: Record<string, readonly Record<string, unknown>[]>,
    factors: readonly FactorContract[] = []
  ): ValidationReport {
    return this.Validate(domain, data, factors);
  }

  private checkReferentialClosure(
    domain: DomainConfig,
    data: Record<string, readonly Record<string, unknown>[]>,
    gates: GateResult[]
  ): void {
    for (const [entityName, entityCfg] of Object.entries(domain.entities)) {
      const records = data[entityName] ?? [];
      for (const fk of Object.values(entityCfg.foreignKeys)) {
        if (!fk.targetField) {
          throw new Error(
            `Validator: FK '${fk.fieldName}' on entity '${entityName}' must explicitly declare 'targetField'`
          );
        }

        const targetRecords = data[fk.targetEntity] ?? [];
        // Normalized case-insensitive set of valid target IDs
        const targetIds = new Set(
          targetRecords.map((r) => {
            const raw = r[fk.targetField];
            return typeof raw === 'string' ? raw.toLowerCase() : String(raw ?? '');
          })
        );

        let danglingCount = 0;
        let examinedFkCount = 0;
        const fieldCfg = entityCfg.fields[fk.fieldName];
        const isNullable = fieldCfg?.nullable ?? true;

        for (const row of records) {
          const rawVal = row[fk.fieldName];
          if (rawVal !== undefined && rawVal !== null && rawVal !== '') {
            examinedFkCount++;
            const normalized = typeof rawVal === 'string' ? rawVal.toLowerCase() : String(rawVal);
            if (!targetIds.has(normalized)) {
              danglingCount++;
            }
          } else if (!isNullable) {
            // Null in non-nullable field
            danglingCount++;
          }
        }

        gates.push({
          name: `FK Closure: ${entityName}.${fk.fieldName} -> ${fk.targetEntity}.${fk.targetField}`,
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
    for (const entityName of Object.keys(domain.entities)) {
      const records = data[entityName] ?? [];
      const seenIds = new Set<string>();
      let duplicateIdCount = 0;

      for (const row of records) {
        const idVal = row['ID'] ?? row['id'];
        if (idVal !== undefined && idVal !== null) {
          const normId = typeof idVal === 'string' ? idVal.toLowerCase() : String(idVal);
          if (seenIds.has(normId)) {
            duplicateIdCount++;
          }
          seenIds.add(normId);
        }
      }

      gates.push({
        name: `PK Uniqueness: ${entityName}.ID`,
        category: 'schema',
        passed: duplicateIdCount === 0,
        populationCount: records.length,
        message:
          duplicateIdCount === 0
            ? `All ${records.length} primary keys are strictly unique`
            : `Found ${duplicateIdCount} duplicate primary keys in ${records.length} records`,
        expected: 0,
        actual: duplicateIdCount,
      });
    }
  }

  private checkFactorContracts(
    data: Record<string, readonly Record<string, unknown>[]>,
    factors: readonly FactorContract[],
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

      // Compile arrows
      const compiledArrows = Object.values(factor.arrows).map((arrow) => ({
        beta: arrow.beta,
        evaluator: compileFeature(arrow.feature),
      }));

      let sumScore = 0;
      for (const record of targetRecords) {
        let recordScore = 0;
        for (const arrow of compiledArrows) {
          recordScore += arrow.beta * arrow.evaluator(record);
        }
        sumScore += sigmoid(recordScore);
      }

      const empiricalMean = sumScore / n;
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
    }
  }
}
