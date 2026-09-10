import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConditionalDistribution,
  CatalogLookup,
  RelativeDateRange,
  EntityConfig,
} from '@memberjunction/loom-contracts';
import { RngStream } from '../math/rng.js';

export interface GeneratorContext {
  parent?: Record<string, unknown>;
  parentPool?: Record<string, readonly Record<string, unknown>[]>;
  catalogs?: Record<string, unknown>;
  rng: RngStream;
  asOfDate?: string;
}

let internalGivenNamesCatalog: { female: string[]; male: string[]; unisex?: string[] } | null = null;

function getInternalGivenNamesCatalog(): { female: string[]; male: string[]; unisex?: string[] } {
  if (!internalGivenNamesCatalog) {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(currentDir, '../identity/given-names.json'),
      join(currentDir, '../../src/identity/given-names.json'),
      join(currentDir, 'given-names.json'),
    ];
    for (const cand of candidates) {
      if (existsSync(cand)) {
        internalGivenNamesCatalog = JSON.parse(readFileSync(cand, 'utf8')) as {
          female: string[];
          male: string[];
          unisex?: string[];
        };
        break;
      }
    }
    if (!internalGivenNamesCatalog) {
      internalGivenNamesCatalog = { female: [], male: [], unisex: [] };
    }
  }
  return internalGivenNamesCatalog;
}

/**
 * Resolves a field path like "Gender" or "parent.Gender" against the current row or parent record.
 */
export function resolveConditionValue(
  fieldPath: string,
  row: Record<string, unknown>,
  context?: GeneratorContext,
  entityCfg?: EntityConfig,
): unknown {
  if (fieldPath.startsWith('parent.')) {
    const pField = fieldPath.slice(7);
    if (context?.parent && context.parent[pField] !== undefined) {
      return context.parent[pField];
    }
    // Try to resolve parent via foreign keys in parentPool
    if (entityCfg && context?.parentPool) {
      for (const fk of Object.values(entityCfg.foreignKeys)) {
        const targetEntity = fk.targetEntity;
        const fkFieldName = fk.fieldName;
        const fkVal = row[fkFieldName];
        if (fkVal !== undefined && fkVal !== null) {
          const targetRows = context.parentPool[targetEntity] ?? [];
          const parentMatch = targetRows.find(
            (pr) => String(pr['ID'] ?? pr['id']).toLowerCase() === String(fkVal).toLowerCase()
          );
          if (parentMatch && parentMatch[pField] !== undefined) {
            return parentMatch[pField];
          }
        }
      }
    }
    return undefined;
  }
  return row[fieldPath];
}

/**
 * Evaluates a conditionalDistribution generator configuration against a row.
 */
export function evaluateConditionalDistribution(
  config: ConditionalDistribution,
  row: Record<string, unknown>,
  context: GeneratorContext,
  entityCfg?: EntityConfig,
): string | number | boolean | null | undefined {
  const condVal = resolveConditionValue(config.conditionalOn, row, context, entityCfg);
  const condStr = condVal !== undefined && condVal !== null ? String(condVal) : '';

  // Match key: direct, case-insensitive, or default/*
  let dist = config.distributions[condStr];
  if (!dist && condStr) {
    const lower = condStr.toLowerCase();
    for (const [k, v] of Object.entries(config.distributions)) {
      if (k.toLowerCase() === lower) {
        dist = v;
        break;
      }
    }
  }
  if (!dist) {
    dist = config.distributions['*'] ?? config.distributions['default'];
  }
  if (!dist || !dist.values || dist.values.length === 0) {
    return undefined;
  }

  if (dist.weights && dist.weights.length === dist.values.length) {
    const options = dist.values.map((val, idx) => ({
      value: val,
      weight: dist!.weights![idx]!,
    }));
    return context.rng.pickWeighted(options);
  }

  return context.rng.pick(dist.values);
}

/**
 * Evaluates a catalogLookup generator configuration against a row.
 */
export function evaluateCatalogLookup(
  config: CatalogLookup,
  row: Record<string, unknown>,
  context: GeneratorContext,
  entityCfg?: EntityConfig,
): string | number | boolean | null | undefined {
  let catalogObj: Record<string, unknown> | readonly Record<string, unknown>[] | undefined;

  if (context.catalogs && context.catalogs[config.catalog]) {
    catalogObj = context.catalogs[config.catalog] as Record<string, unknown>;
  } else if (config.catalog === 'given-names' || config.catalog === 'given_names') {
    catalogObj = getInternalGivenNamesCatalog();
  }

  if (!catalogObj) {
    if (config.catalog === 'given-names') {
      catalogObj = getInternalGivenNamesCatalog();
    } else {
      throw new Error(`CatalogLookup: catalog '${config.catalog}' not found in registered catalogs`);
    }
  }

  if (Array.isArray(catalogObj) && catalogObj.length === 1 && typeof catalogObj[0] === 'object') {
    const first = catalogObj[0] as Record<string, unknown>;
    if (!('Name' in first) && !('ID' in first) && !('id' in first)) {
      catalogObj = first;
    }
  }

  let bucketKey = '';
  const condOn = config.conditionalOn ?? ((config as Record<string, unknown>)['mapBy'] as string | undefined);
  const mapping = config.mappingKey ?? ((config as Record<string, unknown>)['keyMap'] as Record<string, string> | undefined);

  if (condOn) {
    const condVal = resolveConditionValue(condOn, row, context, entityCfg);
    const condStr = condVal !== undefined && condVal !== null ? String(condVal) : '';
    if (mapping) {
      bucketKey = mapping[condStr] ?? '';
      if (!bucketKey) {
        const lower = condStr.toLowerCase();
        for (const [mk, mv] of Object.entries(mapping)) {
          if (mk.toLowerCase() === lower) {
            bucketKey = mv;
            break;
          }
        }
      }
      if (!bucketKey) {
        bucketKey = condStr;
      }
    } else {
      bucketKey = condStr;
    }
  }

  // If catalog is an object with bucket arrays (e.g. { female: [...], male: [...] })
  if (!Array.isArray(catalogObj) && typeof catalogObj === 'object') {
    const buckets = catalogObj as Record<string, unknown>;
    let list: unknown = buckets[bucketKey];
    if (!list && bucketKey) {
      const lower = bucketKey.toLowerCase();
      for (const [bk, bv] of Object.entries(buckets)) {
        if (bk.toLowerCase() === lower) {
          list = bv;
          break;
        }
      }
    }
    if (!list) {
      list = buckets['default'] ?? buckets['unisex'] ?? Object.values(buckets)[0];
    }
    if (Array.isArray(list) && list.length > 0) {
      const picked: unknown = context.rng.pick(list);
      if (typeof picked === 'string' || typeof picked === 'number' || typeof picked === 'boolean') {
        return picked;
      }
      if (picked && typeof picked === 'object') {
        const o = picked as Record<string, unknown>;
        return (o['Name'] ?? o['name'] ?? o['value'] ?? o['Value'] ?? JSON.stringify(o)) as string;
      }
    }
  } else if (Array.isArray(catalogObj)) {
    const rows = catalogObj as readonly Record<string, unknown>[];
    if (rows.length > 0) {
      const picked = context.rng.pick(rows);
      return (picked['Name'] ?? picked['name'] ?? picked['Value'] ?? picked['value'] ?? picked['ID'] ?? '') as string;
    }
  }

  return undefined;
}

/**
 * Evaluates a relativeDateRange generator configuration to produce a bounded date string (YYYY-MM-DD).
 */
export function evaluateRelativeDateRange(
  config: RelativeDateRange,
  row: Record<string, unknown>,
  context: GeneratorContext,
  entityCfg?: EntityConfig,
): string {
  let anchorDateStr = '';

  if (config.relativeTo === 'intakeDate') {
    const val = config.anchorField
      ? resolveConditionValue(config.anchorField, row, context, entityCfg)
      : (row['JoinDate'] ?? row['CreatedAt'] ?? row['StartDate'] ?? row['OrderDate']);
    if (val) anchorDateStr = String(val);
  } else if (config.relativeTo === 'parentDateField') {
    const pField = config.anchorField ?? 'Date';
    const val = context.parent?.[pField] ?? context.parent?.['CreatedAt'];
    if (val) anchorDateStr = String(val);
  } else if (config.relativeTo === 'asOfDate' || config.relativeTo === 'now') {
    anchorDateStr = context.asOfDate ?? '2026-09-02';
  }

  if (!anchorDateStr) {
    anchorDateStr = context.asOfDate ?? '2026-09-02';
  }

  // Parse calendar date parts (YYYY-MM-DD) directly without timezone skew
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(anchorDateStr);
  let anchorYear = 2026;
  let anchorMonth = 9;
  let anchorDay = 2;
  if (dateMatch && dateMatch[1] && dateMatch[2] && dateMatch[3]) {
    anchorYear = parseInt(dateMatch[1], 10);
    anchorMonth = parseInt(dateMatch[2], 10);
    anchorDay = parseInt(dateMatch[3], 10);
  }

  const minOffset = config.minOffsetYears ?? -75;
  const maxOffset = config.maxOffsetYears ?? -18;
  const meanOffset = config.meanOffsetYears ?? -42;
  const stdDev = config.stdDevYears ?? 12;

  let offsetYears: number;
  if (config.distribution === 'uniform') {
    offsetYears = minOffset + context.rng.next() * (maxOffset - minOffset);
  } else {
    // Normal distribution bounded strictly in [minOffset, maxOffset]
    let draw = context.rng.normal(meanOffset, stdDev);
    if (draw < minOffset) draw = minOffset;
    if (draw > maxOffset) draw = maxOffset;
    offsetYears = draw;
  }

  // Calculate target birth date strictly bounded by maxOffsetYears
  const targetYear = anchorYear + Math.round(offsetYears);
  const targetMonth = context.rng.int(1, 12);
  const targetDay = context.rng.int(1, 28);
  let finalYear = targetYear;
  let finalMonth = targetMonth;
  let finalDay = targetDay;

  // Assert minimum age invariant: anchorDate - dob >= 18.0 years
  if (maxOffset <= -18) {
    const latestAllowedYear = anchorYear - 18;
    if (finalYear > latestAllowedYear) {
      finalYear = latestAllowedYear;
    } else if (finalYear === latestAllowedYear) {
      if (
        finalMonth > anchorMonth ||
        (finalMonth === anchorMonth && finalDay > anchorDay)
      ) {
        finalMonth = anchorMonth;
        finalDay = anchorDay;
      }
    }
  }

  const yStr = String(finalYear).padStart(4, '0');
  const mStr = String(finalMonth).padStart(2, '0');
  const dStr = String(finalDay).padStart(2, '0');
  return `${yStr}-${mStr}-${dStr}`;
}

/**
 * Applies all declared field generators (conditionalDistribution, catalogLookup, relativeDateRange)
 * onto a row in-place or returning a new record.
 */
export function applyDeclarativeGeneratorsToRow(
  entityCfg: EntityConfig,
  row: Record<string, unknown>,
  context: GeneratorContext,
): Record<string, unknown> {
  const result = { ...row };

  for (const [fieldName, fieldCfg] of Object.entries(entityCfg.fields)) {
    if (fieldCfg.isPrimaryKey || fieldName === 'ID' || fieldName === 'id') continue;
    if (fieldCfg.avatar || fieldCfg.logo) continue;

    const gen = fieldCfg.generator;
    if (gen && typeof gen === 'object') {
      if (gen.type === 'conditionalDistribution') {
        const val = evaluateConditionalDistribution(gen, result, context, entityCfg);
        if (val !== undefined) {
          result[fieldName] = val;
          row[fieldName] = val;
        }
      } else if (gen.type === 'catalogLookup') {
        const val = evaluateCatalogLookup(gen, result, context, entityCfg);
        if (val !== undefined) {
          result[fieldName] = val;
          row[fieldName] = val;
        }
      } else if (gen.type === 'relativeDateRange' || 'relativeTo' in gen) {
        const dateVal = evaluateRelativeDateRange(gen as RelativeDateRange, result, context, entityCfg);
        result[fieldName] = dateVal;
        row[fieldName] = dateVal;
      }
    } else if (fieldCfg.values && fieldCfg.weights && fieldCfg.weights.length === fieldCfg.values.length) {
      if (result[fieldName] === undefined || result[fieldName] === null) {
        const options = fieldCfg.values.map((v, idx) => ({
          value: v,
          weight: fieldCfg.weights![idx]!,
        }));
        const picked = context.rng.pickWeighted(options);
        result[fieldName] = picked;
        row[fieldName] = picked;
      }
    }
  }

  return result;
}
