import type { DomainConfig, FactorContract, HeroConfig, EraConfig } from '@memberjunction/loom-contracts';
import { compileFeature, compileRawFeature, type RelationalContext } from '../features/compiler.js';
import { HeroInjector } from '../heroes/HeroInjector.js';
import { IdentityService } from '../identity/index.js';

export interface GateResult {
  name: string;
  category: 'referential' | 'factor' | 'schema' | 'hero' | 'era' | 'generated' | 'identity';
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
export interface ValidateOptions {
  factors?: readonly FactorContract[];
  heroes?: readonly HeroConfig[];
  eras?: readonly EraConfig[];
  catalogs?: Record<string, readonly Record<string, unknown>[]>;
}

export class Validator {
  public Validate(
    domain: DomainConfig,
    data: Record<string, readonly Record<string, unknown>[]>,
    factorsOrOptions: readonly FactorContract[] | ValidateOptions | Record<string, readonly Record<string, unknown>[]> = [],
    heroes: readonly HeroConfig[] = [],
    eras: readonly EraConfig[] = [],
    catalogs?: Record<string, readonly Record<string, unknown>[]>
  ): ValidationReport {
    let actualFactors: readonly FactorContract[] = [];
    let actualHeroes: readonly HeroConfig[] = heroes;
    let actualEras: readonly EraConfig[] = eras;
    let actualCatalogs: Record<string, readonly Record<string, unknown>[]> | undefined = catalogs;

    if (Array.isArray(factorsOrOptions)) {
      actualFactors = factorsOrOptions;
    } else if (factorsOrOptions && typeof factorsOrOptions === 'object') {
      const opts = factorsOrOptions as ValidateOptions;
      if (opts.factors !== undefined || opts.heroes !== undefined || opts.eras !== undefined || opts.catalogs !== undefined) {
        actualFactors = opts.factors ?? [];
        actualHeroes = opts.heroes ?? heroes;
        actualEras = opts.eras ?? eras;
        actualCatalogs = opts.catalogs ?? catalogs;
      } else {
        actualCatalogs = factorsOrOptions as Record<string, readonly Record<string, unknown>[]>;
      }
    }

    const gates: GateResult[] = [];

    // Entity record lookup index: entityName -> (id -> record)
    const entityIndex = new Map<string, Map<string, Record<string, unknown>>>();
    const getEntityMap = (entityName: string): Map<string, Record<string, unknown>> => {
      let map = entityIndex.get(entityName);
      if (!map) {
        map = new Map();
        const records = data[entityName] ?? [];
        for (const r of records) {
          const rId = r['ID'] ?? r['id'];
          if (rId !== undefined && rId !== null) {
            map.set(String(rId).toLowerCase(), r as Record<string, unknown>);
          }
        }
        entityIndex.set(entityName, map);
      }
      return map;
    };

    // Child records lookup index: cacheKey -> (parentId -> records[])
    const childrenIndex = new Map<string, Map<string, Record<string, unknown>[]>>();
    const getChildrenMap = (
      childEntity: string,
      parentEntity: string,
      foreignKeyField?: string
    ): Map<string, Record<string, unknown>[]> => {
      const cacheKey = `${childEntity}:${parentEntity}:${foreignKeyField ?? ''}`;
      let map = childrenIndex.get(cacheKey);
      if (!map) {
        map = new Map();
        const records = data[childEntity] ?? [];
        const entityCfg = domain.entities[childEntity];
        const matchingFkFields: string[] = [];
        if (foreignKeyField) {
          matchingFkFields.push(foreignKeyField);
        } else if (entityCfg) {
          for (const [fkKey, fk] of Object.entries(entityCfg.foreignKeys)) {
            if (fk.targetEntity === parentEntity || !parentEntity) {
              matchingFkFields.push(fk.fieldName ?? fkKey);
            }
          }
        }

        for (const r of records) {
          for (const fkField of matchingFkFields) {
            const val = r[fkField];
            if (val !== undefined && val !== null && val !== '') {
              const norm = String(val).toLowerCase();
              let list = map.get(norm);
              if (!list) {
                list = [];
                map.set(norm, list);
              }
              list.push(r as Record<string, unknown>);
            }
          }
        }
        childrenIndex.set(cacheKey, map);
      }
      return map;
    };

    // Construct relational context from available in-memory data
    const relationalCtx: RelationalContext = {
      getEntity: (entityName, id) => {
        return getEntityMap(entityName).get(id.toLowerCase());
      },
      getChildren: (parentEntity, parentId, childEntity, foreignKeyField) => {
        return getChildrenMap(childEntity, parentEntity, foreignKeyField).get(parentId.toLowerCase()) ?? [];
      },
    };

    // Lookup resolution index for O(1) @lookup checking
    const lookupIndex = new LookupIndex(data, actualCatalogs);

    // 0. Hero pins validation (Gate 0)
    this.checkHeroPins(data, actualHeroes, actualFactors, relationalCtx, gates);

    // 1. Referential integrity gates
    this.checkReferentialClosure(domain, data, actualCatalogs, gates, lookupIndex);

    // 2. Primary key uniqueness & non-null fields
    this.checkSchemaInvariants(domain, data, gates);

    // 3. Factor contract tolerance gates (pure empirical verification)
    this.checkFactorContracts(data, actualFactors, relationalCtx, gates);

    // 4. Realized Era volume and factor adjustment gates (B3)
    this.checkRealizedEras(domain, data, actualEras, actualFactors, relationalCtx, gates);

    // 5. Dependent child coverage gates (OrderHeader -> OrderLine & Payment)
    this.checkDependentChildCoverage(domain, data, gates);

    // 6. @lookup resolution gate (M2)
    this.checkLookupResolution(data, actualCatalogs, gates, lookupIndex);

    // 7. Relational rules gates (M2)
    this.checkRelationalRules(domain, data, gates, actualCatalogs);

    // 8. Generated-field uniqueness (loom #12 WP2)
    this.checkGeneratedFieldUniqueness(domain, data, gates);

    // 9. Avatar/logo maxLength
    this.checkGeneratedFieldMaxLength(domain, data, gates);

    // 10. Name–Gender consistency
    this.checkNameGenderConsistency(domain, data, gates);

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
    catalogs: Record<string, readonly Record<string, unknown>[]> | undefined,
    gates: GateResult[],
    lookupIndex?: LookupIndex
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

        const targetRecords = data[fk.targetEntity] ?? (catalogs ? catalogs[fk.targetEntity] : undefined) ?? [];
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
              const res = resolveLookupExpression(rawVal, data, catalogs, lookupIndex);
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

  private checkGeneratedFieldUniqueness(
    domain: DomainConfig,
    data: Record<string, readonly Record<string, unknown>[]>,
    gates: GateResult[],
  ): void {
    for (const [entityName, entityCfg] of Object.entries(domain.entities)) {
      const records = data[entityName] ?? [];
      for (const [fieldName, fieldCfg] of Object.entries(entityCfg.fields)) {
        if (fieldCfg.uniqueness !== 'generated' && !fieldCfg.avatar && !fieldCfg.logo) continue;
        const values = records.map((r) => r[fieldName]).filter((v) => v !== undefined && v !== null && v !== '');
        const unique = new Set(values.map((v) => String(v)));
        const passed = unique.size === records.length && values.length === records.length;
        gates.push({
          name: `Generated uniqueness: ${entityName}.${fieldName}`,
          category: 'generated',
          passed,
          populationCount: records.length,
          message: passed
            ? `All ${records.length} ${fieldName} values are distinct`
            : `${unique.size} distinct ${fieldName} values across ${records.length} records`,
          expected: records.length,
          actual: unique.size,
        });
      }
    }
  }

  private checkGeneratedFieldMaxLength(
    domain: DomainConfig,
    data: Record<string, readonly Record<string, unknown>[]>,
    gates: GateResult[],
  ): void {
    for (const [entityName, entityCfg] of Object.entries(domain.entities)) {
      const records = data[entityName] ?? [];
      for (const [fieldName, fieldCfg] of Object.entries(entityCfg.fields)) {
        const max = fieldCfg.maxLength ?? fieldCfg.avatar?.maxLength;
        if (!max) continue;
        let over = 0;
        for (const row of records) {
          const v = row[fieldName];
          if (typeof v === 'string' && v.length > max) over++;
        }
        gates.push({
          name: `Generated maxLength: ${entityName}.${fieldName}`,
          category: 'generated',
          passed: over === 0,
          populationCount: records.length,
          message:
            over === 0
              ? `All ${records.length} ${fieldName} values are ≤ ${max} chars`
              : `${over} ${fieldName} value(s) exceed maxLength ${max}`,
          expected: 0,
          actual: over,
        });
      }
    }
  }

  private checkNameGenderConsistency(
    domain: DomainConfig,
    data: Record<string, readonly Record<string, unknown>[]>,
    gates: GateResult[],
  ): void {
    for (const [entityName, entityCfg] of Object.entries(domain.entities)) {
      if (!entityCfg.fields.FirstName || !entityCfg.fields.Gender) continue;
      const records = data[entityName] ?? [];
      let mismatches = 0;
      let classified = 0;
      let unclassified = 0;
      for (const row of records) {
        const gender = String(row.Gender ?? '').trim();
        if (!gender || gender.toLowerCase() === 'unknown') continue;
        const inferred = IdentityService.GenderFromName(String(row.FirstName ?? ''));
        if (inferred === 'Unknown') {
          unclassified++;
          continue;
        }
        classified++;
        if (inferred.toLowerCase() !== gender.toLowerCase()) {
          mismatches++;
        }
      }
      gates.push({
        name: `Name-Gender consistency: ${entityName}`,
        category: 'identity',
        passed: mismatches === 0,
        populationCount: classified,
        message:
          mismatches === 0
            ? `All ${classified} classified ${entityName} record(s) match GenderFromName (${unclassified} unclassified)`
            : `${mismatches} of ${classified} classified ${entityName} record(s) disagree with GenderFromName (${unclassified} unclassified)`,
        expected: 0,
        actual: mismatches,
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

    // Pre-cache for parent records by targetEntity:targetField -> Map<normalizedValue, Record<string, unknown>>
    const parentRecordCache = new Map<string, Map<string, Record<string, unknown>>>();
    const getParentRecord = (targetEntity: string, targetField: string, targetVal: string): Record<string, unknown> | undefined => {
      const cacheKey = `${targetEntity.toLowerCase()}:${targetField.toLowerCase()}`;
      let map = parentRecordCache.get(cacheKey);
      if (!map) {
        map = new Map<string, Record<string, unknown>>();
        const rows = data[targetEntity] ?? [];
        for (const row of rows) {
          const v = row[targetField];
          if (v !== undefined && v !== null) {
            map.set(String(v).toLowerCase(), row as Record<string, unknown>);
          }
        }
        parentRecordCache.set(cacheKey, map);
      }
      return map.get(targetVal.toLowerCase());
    };

    // Cache getRowYear per record
    const rowYearCache = new WeakMap<Record<string, unknown>, number | undefined>();
    const getRowYear = (r: Record<string, unknown>, entityCfg: DomainConfig['entities'][string]): number | undefined => {
      if (rowYearCache.has(r)) {
        return rowYearCache.get(r);
      }
      let year: number | undefined;
      const cycleField = Object.keys(entityCfg.fields).find(
        (f) => f === 'Cycle' || f === 'Year' || f.endsWith('Date') || f.endsWith('At')
      );
      if (cycleField) {
        const raw = r[cycleField];
        if (raw !== undefined && raw !== null && raw !== '') {
          year = typeof raw === 'number' ? raw : new Date(String(raw)).getFullYear();
        }
      }
      if (year === undefined || isNaN(year)) {
        // Resolve date via foreign keys (e.g. OrderLine -> OrderHeader.OrderDate)
        for (const fk of Object.values(entityCfg.foreignKeys ?? {})) {
          const fkVal = r[fk.fieldName ?? ''];
          if (fkVal !== undefined && fkVal !== null && fkVal !== '') {
            const parentRow = getParentRecord(fk.targetEntity, fk.targetField, String(fkVal));
            if (parentRow) {
              const parentTargetCfg = domain.entities[fk.targetEntity];
              if (parentTargetCfg) {
                const parentCycleField = Object.keys(parentTargetCfg.fields).find(
                  (f) => f === 'Cycle' || f === 'Year' || f.endsWith('Date') || f.endsWith('At')
                );
                if (parentCycleField && parentRow[parentCycleField]) {
                  const raw = parentRow[parentCycleField];
                  const y = typeof raw === 'number' ? raw : new Date(String(raw)).getFullYear();
                  if (!isNaN(y)) {
                    year = y;
                    break;
                  }
                }
              }
            }
          }
        }
      }
      const finalYear = year !== undefined && !isNaN(year) ? year : undefined;
      rowYearCache.set(r, finalYear);
      return finalYear;
    };

    const matchesWhere = (
      r: Record<string, unknown>,
      entityCfg: DomainConfig['entities'][string],
      where?: Record<string, unknown>
    ): boolean => {
      if (!where) return true;
      for (const [wKey, wVal] of Object.entries(where)) {
        if (r[wKey] !== undefined) {
          if (String(r[wKey]).toLowerCase() !== String(wVal).toLowerCase()) return false;
        } else {
          let matchedRel = false;
          for (const fk of Object.values(entityCfg.foreignKeys ?? {})) {
            const fkVal = r[fk.fieldName ?? ''];
            if (fkVal !== undefined && fkVal !== null && fkVal !== '') {
              const parent = getParentRecord(fk.targetEntity, fk.targetField, String(fkVal));
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
      return true;
    };

    const entityRecordsByCycle = new Map<string, Map<number, Record<string, unknown>[]>>();
    const getRecordsForEntityCycle = (
      entityName: string,
      cycle: number
    ): Record<string, unknown>[] => {
      let cycleMap = entityRecordsByCycle.get(entityName);
      if (!cycleMap) {
        cycleMap = new Map<number, Record<string, unknown>[]>();
        const rows = data[entityName] ?? [];
        const cfg = domain.entities[entityName];
        if (cfg) {
          for (const row of rows) {
            const y = getRowYear(row, cfg);
            if (y !== undefined) {
              let list = cycleMap.get(y);
              if (!list) {
                list = [];
                cycleMap.set(y, list);
              }
              list.push(row as Record<string, unknown>);
            }
          }
        }
        entityRecordsByCycle.set(entityName, cycleMap);
      }
      return cycleMap.get(cycle) ?? [];
    };

    const baselineScopedCache = new Map<string, number>();

    for (const era of eras) {
      // 1. Volume Multipliers Gate
      for (const vm of era.volumeMultipliers) {
        const entityCfg = domain.entities[vm.entity];
        if (!entityCfg) continue;

        // Find pure non-era baseline cycles for this entity
        const allEntityEraCycles = eras.flatMap((e) =>
          e.volumeMultipliers.some((vm2) => vm2.entity === vm.entity) ? e.cycles : []
        );
        const nonEraCycles = derivedCycles.filter((cy) => !allEntityEraCycles.includes(cy));

        // Helper to calculate baseline scoped count for any volume multiplier (R13-1)
        const calcBaselineScoped = (targetVM: typeof vm): number => {
          const vmKey = `${targetVM.entity}:${JSON.stringify(targetVM.where ?? {})}`;
          const cached = baselineScopedCache.get(vmKey);
          if (cached !== undefined) return cached;

          let sc = 0;
          let samples = 0;
          for (const cy of nonEraCycles) {
            const inCyRecords = getRecordsForEntityCycle(targetVM.entity, cy);
            const inCy = inCyRecords.filter((r) => matchesWhere(r, entityCfg, targetVM.where)).length;
            sc += inCy;
            samples++;
          }
          const result = samples > 0 ? sc / samples : 0;
          baselineScopedCache.set(vmKey, result);
          return result;
        };

        let baselineTotalCount = 0;
        let nonEraSamples = 0;
        for (const cy of nonEraCycles) {
          const totalInCy = getRecordsForEntityCycle(vm.entity, cy).length;
          baselineTotalCount += totalInCy;
          nonEraSamples++;
        }
        const avgBaselineScoped = calcBaselineScoped(vm);
        const avgBaselineTotal = nonEraSamples > 0 ? baselineTotalCount / nonEraSamples : 0;

        for (const targetCycle of era.cycles) {
          const allInEraCycle = getRecordsForEntityCycle(vm.entity, targetCycle);
          const matchingInEraCycle = allInEraCycle.filter((r) => matchesWhere(r, entityCfg, vm.where));

          const realizedScoped = matchingInEraCycle.length;
          const realizedTotal = allInEraCycle.length;
          const effectiveAvgBaselineTotal = avgBaselineTotal > 0 ? avgBaselineTotal : allInEraCycle.length;

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

            const effectiveBaselineTotal = effectiveAvgBaselineTotal * parentMultiplier;
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
              const expectedCount = effectiveAvgBaselineTotal * vm.multiplier * childRetentionRate;
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

        const factorEvalCache = new WeakMap<Record<string, unknown>, boolean>();
        const evalRecord = (r: Record<string, unknown>): boolean => {
          let res = factorEvalCache.get(r);
          if (res === undefined) {
            res = Boolean(evalFn(r, ctx));
            factorEvalCache.set(r, res);
          }
          return res;
        };

        for (const targetCycle of era.cycles) {
          const cycleRecords = getRecordsForEntityCycle(contract.effect, targetCycle);
          if (cycleRecords.length === 0) continue;

          let positiveCountInCycle = 0;
          for (const r of cycleRecords) {
            if (evalRecord(r)) positiveCountInCycle++;
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
            const cyRecords = getRecordsForEntityCycle(contract.effect, cy);
            for (const r of cyRecords) {
              if (evalRecord(r)) refPositive++;
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
    catalogs: Record<string, readonly Record<string, unknown>[]> | undefined,
    gates: GateResult[],
    lookupIndex?: LookupIndex
  ): void {
    let totalLookups = 0;
    let unresolvedCount = 0;
    const failureMessages: string[] = [];

    for (const [entityName, records] of Object.entries(data)) {
      for (const row of records) {
        for (const [field, val] of Object.entries(row)) {
          if (typeof val === 'string' && val.startsWith('@lookup:')) {
            totalLookups++;
            const res = resolveLookupExpression(val, data, catalogs, lookupIndex);
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
        ? `All ${totalLookups} @lookup expression(s) resolved cleanly across dataset and catalogs`
        : `Found ${unresolvedCount} unresolved @lookup expression(s) among ${totalLookups} examined: ${failureMessages.join('; ')}`,
      expected: 0,
      actual: unresolvedCount,
    });
  }

  private checkRelationalRules(
    domain: DomainConfig,
    data: Record<string, readonly Record<string, unknown>[]>,
    gates: GateResult[],
    catalogs?: Record<string, readonly Record<string, unknown>[]>
  ): void {
    // 1. Build declared entities set for validation (R2-3)
    const declaredEntityNames = new Set<string>();
    for (const [k, cfg] of Object.entries(domain.entities)) {
      declaredEntityNames.add(k.toLowerCase());
      if (cfg.entityName) declaredEntityNames.add(cfg.entityName.toLowerCase());
      if (cfg.outputDirectory) declaredEntityNames.add(cfg.outputDirectory.toLowerCase());
      if (cfg.targetTable) declaredEntityNames.add(cfg.targetTable.toLowerCase());
    }
    for (const k of Object.keys(data)) {
      declaredEntityNames.add(k.toLowerCase());
    }
    if (catalogs) {
      for (const k of Object.keys(catalogs)) {
        declaredEntityNames.add(k.toLowerCase());
      }
    }

    const assertEntityDeclared = (entityName: string, ruleName: string) => {
      if (!entityName || !declaredEntityNames.has(entityName.toLowerCase())) {
        throw new Error(
          `Relational rule '${ruleName}': unknown entity '${entityName}' referenced in rule definition. Entity must be declared in domain.entities or provided via catalogs.`
        );
      }
    };

    // 2. Validate all entity references upfront across all declared relational rules (R2-3)
    for (const rule of domain.relationalRules ?? []) {
      assertEntityDeclared(rule.sourceEntity, rule.name);
      if (rule.kind === 'path-match') {
        for (const segment of rule.path) {
          const colonIdx = segment.indexOf(':');
          const targetEntityName = colonIdx >= 0 ? segment.slice(colonIdx + 1) : '';
          if (targetEntityName) assertEntityDeclared(targetEntityName, rule.name);
        }
        if (rule.inclusion) {
          assertEntityDeclared(rule.inclusion.poolEntity, rule.name);
        }
      } else if (rule.kind === 'date-window') {
        assertEntityDeclared(rule.windowEntity, rule.name);
        if (rule.linkEntity) {
          assertEntityDeclared(rule.linkEntity, rule.name);
        }
      } else if (rule.kind === 'text-contains-path') {
        for (const segment of rule.path) {
          const colonIdx = segment.indexOf(':');
          const targetEntityName = colonIdx >= 0 ? segment.slice(colonIdx + 1) : '';
          if (targetEntityName) assertEntityDeclared(targetEntityName, rule.name);
        }
        if (rule.childReferences) {
          assertEntityDeclared(rule.childReferences.childEntity, rule.name);
        }
      } else if (rule.kind === 'outcome-derived-from-ballots') {
        assertEntityDeclared(rule.ballotEntity, rule.name);
      }
    }

    const findRecords = (name: string): readonly Record<string, unknown>[] => {
      const norm = name.toLowerCase();
      for (const [k, v] of Object.entries(data)) {
        if (k.toLowerCase() === norm) return v;
        const cfg = domain.entities[k];
        if (cfg) {
          if (cfg.entityName && cfg.entityName.toLowerCase() === norm) return v;
          if (cfg.outputDirectory && cfg.outputDirectory.toLowerCase() === norm) return v;
          if (cfg.targetTable && cfg.targetTable.toLowerCase() === norm) return v;
        }
      }
      if (catalogs) {
        for (const [k, v] of Object.entries(catalogs)) {
          if (k.toLowerCase() === norm) return v;
        }
      }
      return [];
    };

    // Cached record-by-ID map for O(1) path hop resolution (R2-6)
    const entityRecordById = new Map<string, Map<string, Record<string, unknown>>>();
    const getEntityRecordMap = (entityName: string): Map<string, Record<string, unknown>> => {
      const norm = entityName.toLowerCase();
      let map = entityRecordById.get(norm);
      if (!map) {
        map = new Map();
        const records = findRecords(entityName);
        for (const r of records) {
          const id = r['ID'] ?? r['id'];
          if (id !== undefined && id !== null) {
            map.set(String(id).toLowerCase(), r as Record<string, unknown>);
          }
        }
        entityRecordById.set(norm, map);
      }
      return map;
    };

    for (const rule of domain.relationalRules ?? []) {
      const sourceRecords = findRecords(rule.sourceEntity);
      if (sourceRecords.length === 0) {
        // R2-3: an entity with zero rows still emits a gate with populationCount: 0
        gates.push({
          name: `Relational Integrity: ${rule.name}`,
          category: 'referential',
          passed: true,
          populationCount: 0,
          message: `Source entity '${rule.sourceEntity}' has 0 records; rule '${rule.name}' evaluated vacuously`,
          expected: 0,
          actual: 0,
        });
        continue;
      }

      if (rule.kind === 'path-match') {
        let invalidCount = 0;

        // Pre-index inclusion pool into a Set for O(1) membership checks (R2-6)
        let poolSet: Set<string> | undefined;
        if (rule.inclusion) {
          const inc = rule.inclusion;
          const poolRecords = findRecords(inc.poolEntity);
          poolSet = new Set<string>();
          for (const p of poolRecords) {
            const pItem = String(p[inc.poolItemField] ?? '').toLowerCase();
            const pContainer = String(p[inc.poolContainerField] ?? '').toLowerCase();
            poolSet.add(`${pItem}:${pContainer}`);
          }
        }

        for (const row of sourceRecords) {
          let current: Record<string, unknown> | undefined = row;
          for (let i = 0; i < rule.path.length; i++) {
            if (!current) break;
            const segment = rule.path[i]!;
            const colonIdx = segment.indexOf(':');
            const fkField = colonIdx >= 0 ? segment.slice(0, colonIdx) : segment;
            const targetEntityName = colonIdx >= 0 ? segment.slice(colonIdx + 1) : '';
            const fkVal: unknown = current[fkField];
            if (!fkVal) {
              current = undefined;
              break;
            }
            const targetMap = getEntityRecordMap(targetEntityName);
            current = targetMap.get(String(fkVal).toLowerCase());
          }

          if (!current) {
            invalidCount++;
            continue;
          }

          const targetVal = current[rule.targetField];
          if (targetVal === undefined) {
            invalidCount++;
            continue;
          }

          if (rule.sourceField) {
            const sourceVal = row[rule.sourceField];
            if (
              sourceVal === undefined ||
              String(sourceVal).toLowerCase() !== String(targetVal).toLowerCase()
            ) {
              invalidCount++;
              continue;
            }
          }

          if (poolSet && rule.inclusion) {
            const inc = rule.inclusion;
            const sourceItemVal = String(row[inc.sourceItemField] ?? '').toLowerCase();
            const containerVal = String(targetVal).toLowerCase();
            if (!poolSet.has(`${sourceItemVal}:${containerVal}`)) {
              invalidCount++;
            }
          }
        }

        const passed = invalidCount === 0;
        gates.push({
          name: `Relational Integrity: ${rule.name}`,
          category: 'referential',
          passed,
          populationCount: sourceRecords.length,
          message: passed
            ? `All ${sourceRecords.length} record(s) conform to rule '${rule.name}'`
            : `Found ${invalidCount} record(s) violating rule '${rule.name}' across ${sourceRecords.length} records`,
          expected: 0,
          actual: invalidCount,
        });
      } else if (rule.kind === 'date-window') {
        const windowRecords = findRecords(rule.windowEntity);
        const linkRecords = rule.linkEntity ? findRecords(rule.linkEntity) : [];

        const entityToTarget = new Map<string, string>();
        if (rule.linkEntity && rule.linkSourceField && rule.linkTargetField) {
          for (const l of linkRecords) {
            const sId = String(l[rule.linkSourceField] ?? '').toLowerCase();
            const tId = String(l[rule.linkTargetField] ?? '').toLowerCase();
            if (sId && tId) entityToTarget.set(sId, tId);
          }
        }

        const targetWindows = new Map<string, Array<{ start: string; end: string }>>();
        for (const w of windowRecords) {
          const rawKey = w[rule.windowForeignKey] ?? w['ID'] ?? w['id'];
          const tId = rawKey !== undefined && rawKey !== null ? String(rawKey).toLowerCase() : '';
          const rawStart = w[rule.windowStartField];
          const rawEnd = w[rule.windowEndField];
          const start = rawStart !== undefined && rawStart !== null && rawStart !== '' ? String(rawStart).slice(0, 10) : '';
          const end = rawEnd !== undefined && rawEnd !== null && rawEnd !== '' ? String(rawEnd).slice(0, 10) : '\uffff';
          if (tId) {
            let list = targetWindows.get(tId);
            if (!list) {
              list = [];
              targetWindows.set(tId, list);
            }
            list.push({ start, end });
          }
        }

        let outOfWindowCount = 0;
        let examinedCount = 0;

        for (const row of sourceRecords) {
          const rowId = String(row['ID'] ?? row['id'] ?? '').toLowerCase();
          const targetId = entityToTarget.get(rowId) ?? String(row[rule.windowForeignKey] ?? '').toLowerCase();
          const windows = targetId ? targetWindows.get(targetId) : undefined;
          if (windows && windows.length > 0) {
            examinedCount++;
            const rawDate = String(row[rule.dateField] ?? '').slice(0, 10);
            if (rawDate) {
              const inWindow = windows.some((w) => rawDate >= w.start && rawDate <= w.end);
              if (!inWindow) {
                outOfWindowCount++;
              }
            }
          } else if (rule.requireWindow) {
            examinedCount++;
            outOfWindowCount++;
          }
        }

        const passed = outOfWindowCount === 0;
        gates.push({
          name: `Relational Integrity: ${rule.name}`,
          category: 'referential',
          passed,
          populationCount: examinedCount,
          message: passed
            ? `All ${examinedCount} record(s) fall strictly within declared temporal window`
            : `Found ${outOfWindowCount} record(s) outside temporal window across ${examinedCount} examined`,
          expected: 0,
          actual: outOfWindowCount,
        });
      } else if (rule.kind === 'text-contains-path') {
        let invalidCount = 0;

        // Pre-index child references by foreignKey parent ID for O(1) retrieval (R2-6)
        const childMap = new Map<string, string[]>();
        if (rule.childReferences) {
          const cr = rule.childReferences;
          const childTable = findRecords(cr.childEntity);
          for (const child of childTable) {
            const pId = String(child[cr.foreignKey] ?? '').toLowerCase();
            const val = String(child[cr.childField] ?? '').trim();
            if (val) {
              let arr = childMap.get(pId);
              if (!arr) {
                arr = [];
                childMap.set(pId, arr);
              }
              arr.push(val);
            }
          }
        }

        for (const row of sourceRecords) {
          let current: Record<string, unknown> | undefined = row;
          for (let i = 0; i < rule.path.length; i++) {
            if (!current) break;
            const segment = rule.path[i]!;
            const colonIdx = segment.indexOf(':');
            const fkField = colonIdx >= 0 ? segment.slice(0, colonIdx) : segment;
            const targetEntityName = colonIdx >= 0 ? segment.slice(colonIdx + 1) : '';
            const fkVal: unknown = current[fkField];
            if (!fkVal) {
              current = undefined;
              break;
            }
            const targetMap = getEntityRecordMap(targetEntityName);
            current = targetMap.get(String(fkVal).toLowerCase());
          }

          if (!current) {
            invalidCount++;
            continue;
          }

          const textVal = String(row[rule.textField] ?? '');
          let missingReference = false;
          for (const f of rule.targetFields) {
            const refVal = String(current[f] ?? '').trim();
            if (refVal && !textVal.includes(refVal)) {
              missingReference = true;
              break;
            }
          }

          if (rule.childReferences) {
            const parentId = String(current['ID'] ?? current['id'] ?? '').toLowerCase();
            const childValues = childMap.get(parentId) ?? [];
            for (const childVal of childValues) {
              if (!textVal.includes(childVal)) {
                missingReference = true;
                break;
              }
            }
          }

          if (missingReference) {
            invalidCount++;
          }
        }

        const passed = invalidCount === 0;
        gates.push({
          name: `Relational Integrity: ${rule.name}`,
          category: 'referential',
          passed,
          populationCount: sourceRecords.length,
          message: passed
            ? `All ${sourceRecords.length} record(s) contain required contextual references`
            : `Found ${invalidCount} record(s) lacking required contextual references across ${sourceRecords.length} records`,
          expected: 0,
          actual: invalidCount,
        });

      } else if (rule.kind === 'outcome-derived-from-ballots') {
        const ballotRecords = findRecords(rule.ballotEntity);
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

        let disagreeCount = 0;
        for (const row of sourceRecords) {
          const decisionId = String(row['ID'] ?? row['id'] ?? '').toLowerCase();
          const ballots = ballotsByDecision.get(decisionId) ?? [];

          let posVotes = 0;
          let negVotes = 0;
          let abstainVotes = 0;
          const abstainVal = (rule.abstainVoteValue ?? 'Abstain').trim().toLowerCase();
          for (const b of ballots) {
            const voteVal = String(b[rule.ballotVoteField] ?? '').trim().toLowerCase();
            if (voteVal === rule.positiveVoteValue.toLowerCase()) {
              posVotes++;
            } else if (voteVal === rule.negativeVoteValue.toLowerCase()) {
              negVotes++;
            } else if (voteVal === abstainVal) {
              abstainVotes++;
            }
          }

          const minQuorum = rule.quorum ?? 1;
          const quorumParticipants = rule.abstainHandling === 'count-toward-quorum'
            ? posVotes + negVotes + abstainVotes
            : posVotes + negVotes;

          let expectedOutcome: string;
          if (quorumParticipants < minQuorum) {
            expectedOutcome = rule.failedOutcomeValue;
          } else if (rule.rule === 'supermajority-two-thirds') {
            expectedOutcome = posVotes >= 2 * negVotes && posVotes > 0 ? rule.passedOutcomeValue : rule.failedOutcomeValue;
          } else if (rule.rule === 'unanimous') {
            expectedOutcome = posVotes > 0 && negVotes === 0 ? rule.passedOutcomeValue : rule.failedOutcomeValue;
          } else {
            if (posVotes > negVotes) {
              expectedOutcome = rule.passedOutcomeValue;
            } else if (posVotes < negVotes) {
              expectedOutcome = rule.failedOutcomeValue;
            } else {
              if (rule.tieRule === 'Passed') {
                expectedOutcome = rule.passedOutcomeValue;
              } else if (rule.tieRule === 'Failed') {
                expectedOutcome = rule.failedOutcomeValue;
              } else {
                expectedOutcome = rule.tieOutcomeValue ?? rule.failedOutcomeValue;
              }
            }
          }

          const actualOutcome = String(row[rule.outcomeField] ?? '').trim();
          if (actualOutcome.toLowerCase() !== expectedOutcome.toLowerCase()) {
            disagreeCount++;
          }
        }

        const passed = disagreeCount === 0;
        gates.push({
          name: `Relational Integrity: ${rule.name}`,
          category: 'referential',
          passed,
          populationCount: sourceRecords.length,
          message: passed
            ? `All ${sourceRecords.length} outcome record(s) strictly derived from vote tallies`
            : `Found ${disagreeCount} outcome record(s) disagreeing with vote tallies across ${sourceRecords.length} records`,
          expected: 0,
          actual: disagreeCount,
        });
      }
    }
  }
}

export class LookupIndex {
  private index = new Map<string, Map<string, Set<string>>>();

  constructor(
    data: Record<string, readonly Record<string, unknown>[]>,
    catalogs?: Record<string, readonly Record<string, unknown>[]>
  ) {
    this.indexPool(data);
    if (catalogs) {
      this.indexPool(catalogs);
    }
  }

  private indexPool(pool: Record<string, readonly Record<string, unknown>[]>): void {
    for (const [eName, rows] of Object.entries(pool)) {
      if (rows.length === 0) continue;
      const entityNames: string[] = [eName.toLowerCase()];
      const firstRow = rows[0];
      const altName = firstRow ? (firstRow['_entityName'] ?? firstRow['__entityName']) : undefined;
      if (typeof altName === 'string' && altName.length > 0) {
        entityNames.push(altName.toLowerCase());
      }
      for (const name of entityNames) {
        let fieldMap = this.index.get(name);
        if (!fieldMap) {
          fieldMap = new Map<string, Set<string>>();
          this.index.set(name, fieldMap);
        }
        for (const row of rows) {
          for (const [field, val] of Object.entries(row)) {
            if (val !== undefined && val !== null) {
              const fLower = field.toLowerCase();
              let valSet = fieldMap.get(fLower);
              if (!valSet) {
                valSet = new Set<string>();
                fieldMap.set(fLower, valSet);
              }
              valSet.add(String(val).trim().toLowerCase());
            }
          }
        }
      }
    }
  }

  public has(targetEntity: string, targetField: string, targetValue: string): boolean {
    const fieldMap = this.index.get(targetEntity.toLowerCase());
    if (!fieldMap) return false;
    const valSet = fieldMap.get(targetField.toLowerCase());
    if (!valSet) return false;
    return valSet.has(targetValue.trim().toLowerCase());
  }
}

/**
 * Resolves an '@lookup:<Entity>.<Field>=<Value>' expression against in-memory simulation records
 * or supplied external catalog datasets.
 */
export function resolveLookupExpression(
  lookupExpr: string,
  data: Record<string, readonly Record<string, unknown>[]>,
  catalogs?: Record<string, readonly Record<string, unknown>[]>,
  lookupIndex?: LookupIndex
): { resolved: boolean; error?: string } {
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

  if (lookupIndex) {
    if (lookupIndex.has(targetEntity, targetField, targetValue)) {
      return { resolved: true };
    }
    return { resolved: false, error: `Target record not found for lookup: ${lookupExpr}` };
  }

  const normVal = targetValue.trim().toLowerCase();

  const searchPool = (pool: Record<string, readonly Record<string, unknown>[]>) => {
    for (const [eName, rows] of Object.entries(pool)) {
      if (
        eName.toLowerCase() === targetEntity.toLowerCase() ||
        (rows.length > 0 && String(rows[0]?.['_entityName'] ?? rows[0]?.['__entityName'] ?? '').toLowerCase() === targetEntity.toLowerCase())
      ) {
        const found = rows.some((r) => {
          const v = r[targetField];
          return v !== undefined && v !== null && String(v).trim().toLowerCase() === normVal;
        });
        if (found) return true;
      }
    }
    return false;
  };

  if (searchPool(data)) {
    return { resolved: true };
  }

  if (catalogs && searchPool(catalogs)) {
    return { resolved: true };
  }

  return { resolved: false, error: `Target record not found for lookup: ${lookupExpr}` };
}
