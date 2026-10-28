import * as fs from 'node:fs/promises';
import { IdentityService, GetPrimaryKeyFields, applyFieldGeneratorsToRow } from '@memberjunction/loom-engine';
import {
  AccumulatePlanSchema,
  type AccumulatePlan,
  type PlanFieldValue,
  type PlanRecord,
  type DomainConfig,
  type EntityConfig,
} from '@memberjunction/loom-contracts';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}/;

export async function loadAccumulatePlan(planPath: string): Promise<AccumulatePlan> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(planPath, 'utf8'));
  } catch (err) {
    throw new Error(`Accumulate plan '${planPath}' could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = AccumulatePlanSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Accumulate plan '${planPath}' is invalid:\n  ${issues.join('\n  ')}`);
  }
  return parsed.data;
}

export interface ApplyPlanOptions {
  domain: DomainConfig;
  plan: AccumulatePlan;
  /** Every record of every entity as the cycle stands; planned rows are appended in place. */
  records: Record<string, Record<string, unknown>[]>;
  identityService: IdentityService;
}

export interface ApplyPlanResult {
  added: Record<string, number>;
  /** The fields each appended row took from the plan; later passes must leave them as planned. */
  supplied: Map<Record<string, unknown>, Set<string>>;
  /** Per entity, the declared fields no plan record supplied and no generator filled, written as null. */
  nulled: Record<string, string[]>;
}

const fkFieldName = (key: string, fk: { fieldName?: string }): string => fk.fieldName ?? key;

function foreignKeyFor(entityCfg: EntityConfig, field: string) {
  for (const [key, fk] of Object.entries(entityCfg.foreignKeys ?? {})) {
    if (fkFieldName(key, fk) === field) return fk;
  }
  return undefined;
}

/** The entity a row of `entity` also counts as: itself, then its IsA parents. */
function lineageOf(domain: DomainConfig, entity: string): string[] {
  const out = [entity];
  let cur = domain.entities[entity];
  while (cur?.composition?.isA && !out.includes(cur.composition.isA.parentEntity)) {
    out.push(cur.composition.isA.parentEntity);
    cur = domain.entities[cur.composition.isA.parentEntity];
  }
  return out;
}

const keyOf = (row: Record<string, unknown>, field = 'ID'): string => String(row[field] ?? (field === 'ID' ? row['id'] : '') ?? '');

/**
 * Appends a plan's records to the cycle. Every problem in the plan is collected and thrown together, before
 * any record is added, so a bad plan leaves the cycle untouched and the author sees everything to fix at once.
 */
export function applyAccumulatePlan(options: ApplyPlanOptions): ApplyPlanResult {
  const { domain, plan, records, identityService } = options;
  const problems: string[] = [];
  const at = (i: number, r: PlanRecord) => `records[${i}] (${r.entity}${r.ref ? ` '${r.ref}'` : ''})`;

  // ── 1. Entities, refs and extends are well formed ──
  const byRef = new Map<string, { index: number; record: PlanRecord }>();
  plan.records.forEach((r, i) => {
    if (!domain.entities[r.entity]) problems.push(`${at(i, r)}: unknown entity '${r.entity}'`);
    if (r.ref) {
      if (byRef.has(r.ref)) problems.push(`${at(i, r)}: ref '${r.ref}' is already used by records[${byRef.get(r.ref)!.index}]`);
      else byRef.set(r.ref, { index: i, record: r });
    }
  });
  for (const entity of Object.keys(plan.intake)) {
    if (!domain.entities[entity]) problems.push(`intake: unknown entity '${entity}'`);
  }
  if (problems.length) throw planError(problems);

  // ── 2. Mint every planned key (IsA children take their parent's) ──
  const keys = new Map<number, Record<string, unknown>>();
  const mint = (i: number, seen: Set<number> = new Set()): Record<string, unknown> | undefined => {
    if (keys.has(i)) return keys.get(i);
    const r = plan.records[i]!;
    const cfg = domain.entities[r.entity]!;
    const pkFields = GetPrimaryKeyFields(cfg);
    const isA = cfg.composition?.isA;
    if (isA) {
      if (!r.extends) { problems.push(`${at(i, r)}: ${r.entity} extends ${isA.parentEntity}; name the planned parent with "extends"`); return undefined; }
      const parent = byRef.get(r.extends);
      if (!parent) { problems.push(`${at(i, r)}: extends '${r.extends}', which is not a ref in this plan`); return undefined; }
      if (!lineageOf(domain, parent.record.entity).includes(isA.parentEntity)) {
        problems.push(`${at(i, r)}: extends '${r.extends}', a ${parent.record.entity}, but ${r.entity} extends ${isA.parentEntity}`);
        return undefined;
      }
      if (seen.has(parent.index)) { problems.push(`${at(i, r)}: extends chain loops back on itself`); return undefined; }
      const parentKey = mint(parent.index, new Set([...seen, i]));
      if (parentKey) keys.set(i, { ...parentKey });
      return keys.get(i);
    }
    if (r.extends) { problems.push(`${at(i, r)}: ${r.entity} is not an IsA child, so "extends" does not apply`); return undefined; }
    if (pkFields.length !== 1 || pkFields[0] !== 'ID') {
      // Natural keys come from the plan itself
      const missing = pkFields.filter((f) => typeof r.fields[f] !== 'string' && typeof r.fields[f] !== 'number');
      if (missing.length) { problems.push(`${at(i, r)}: ${r.entity} is keyed by ${pkFields.join(', ')}; supply ${missing.join(', ')}`); return undefined; }
      keys.set(i, Object.fromEntries(pkFields.map((f) => [f, r.fields[f]])));
      return keys.get(i);
    }
    if ('ID' in r.fields || 'id' in r.fields) { problems.push(`${at(i, r)}: do not supply ID; Loom mints it`); return undefined; }
    // Same key as a generated row would get when the entity declares a business key, so a planned duplicate collides
    const businessKeys = (cfg.businessKey ?? []).filter((k) => k !== 'ID' && k !== 'id');
    const literal = businessKeys.map((k) => r.fields[k]);
    const parts = businessKeys.length && literal.every((v) => typeof v === 'string' || typeof v === 'number')
      ? literal.map(String)
      : ['plan', plan.asOf, r.ref ?? `#${i}`];
    keys.set(i, { ID: identityService.MintId(domain.name, r.entity, parts) });
    return keys.get(i);
  };
  plan.records.forEach((_, i) => mint(i));
  if (problems.length) throw planError(problems);

  // ── 3. No planned key may already exist ──
  const seenKeys = new Map<string, number>();
  plan.records.forEach((r, i) => {
    const cfg = domain.entities[r.entity]!;
    const pkFields = GetPrimaryKeyFields(cfg);
    const key = pkFields.map((f) => String(keys.get(i)![f]).toLowerCase()).join('|');
    const tag = `${r.entity}:${key}`;
    if (seenKeys.has(tag)) problems.push(`${at(i, r)}: same ${pkFields.join(', ')} as records[${seenKeys.get(tag)}]`);
    seenKeys.set(tag, i);
    const clash = (records[r.entity] ?? []).some((row) => pkFields.map((f) => keyOf(row, f).toLowerCase()).join('|') === key);
    if (clash) problems.push(`${at(i, r)}: a ${r.entity} with ${pkFields.join(', ')} ${key} already exists`);
    // A business key is unique too, whatever key the existing row was given
    const businessKeys = (cfg.businessKey ?? []).filter((k) => k !== 'ID' && k !== 'id' && !pkFields.includes(k));
    const bk = businessKeys.map((k) => r.fields[k]);
    if (businessKeys.length && bk.every((v) => typeof v === 'string' || typeof v === 'number')) {
      const want = bk.map((v) => String(v).toLowerCase()).join('|');
      const dupe = (records[r.entity] ?? []).some((row) => businessKeys.map((k) => String(row[k] ?? '').toLowerCase()).join('|') === want);
      if (dupe) problems.push(`${at(i, r)}: a ${r.entity} with ${businessKeys.map((k, j) => `${k} ${JSON.stringify(bk[j])}`).join(', ')} already exists`);
    }
  });
  if (problems.length) throw planError(problems);

  // ── 4. Resolve every field against the domain ──
  const rows: Record<string, unknown>[] = plan.records.map((_, i) => ({ ...keys.get(i)! }));
  const pool = (entity: string): Record<string, unknown>[] => [
    ...(records[entity] ?? []),
    ...plan.records.flatMap((r, i) => (r.entity === entity ? [rows[i]!] : [])),
  ];

  plan.records.forEach((r, i) => {
    const cfg = domain.entities[r.entity]!;
    const row = rows[i]!;
    for (const [field, value] of Object.entries(r.fields)) {
      if (row[field] !== undefined && GetPrimaryKeyFields(cfg).includes(field)) continue;
      const fieldCfg = cfg.fields[field];
      if (!fieldCfg) {
        problems.push(`${at(i, r)}: ${r.entity} has no field '${field}' (fields: ${Object.keys(cfg.fields).join(', ')})`);
        continue;
      }
      const resolved = resolveValue(r.entity, cfg, field, value, i, r);
      if (resolved !== undefined) row[field] = resolved;
    }
    // Dependent children cannot be composed without their parent key
    for (const [key, fk] of Object.entries(cfg.foreignKeys ?? {})) {
      const f = fkFieldName(key, fk);
      if (fk.dependent && (row[f] === undefined || row[f] === null)) problems.push(`${at(i, r)}: ${f} is required (${r.entity} belongs to a ${fk.targetEntity})`);
    }
    for (const [f, fc] of Object.entries(cfg.fields)) {
      if (row[f] === undefined && fc.defaultValue !== undefined) row[f] = fc.defaultValue;
    }
  });
  if (problems.length) throw planError(problems);

  // The domain's own generators (avatars, logos, declarative rules) fill what the plan left out; the
  // placeholder fallbacks in generateEntityRecord never run on a planned row. Anything still empty is null.
  const nulled: Record<string, Set<string>> = {};
  plan.records.forEach((r, i) => {
    const cfg = domain.entities[r.entity]!;
    const row = rows[i]!;
    const generated = applyFieldGeneratorsToRow(cfg, { ...row }, r.entity, { parentPool: records });
    for (const [f, v] of Object.entries(generated)) {
      if (row[f] === undefined && !(f in r.fields)) row[f] = v;
    }
    for (const f of Object.keys(cfg.fields)) {
      if (row[f] === undefined) {
        row[f] = null;
        (nulled[r.entity] ??= new Set()).add(f);
      }
    }
  });

  function resolveValue(entity: string, cfg: EntityConfig, field: string, value: PlanFieldValue, i: number, r: PlanRecord): unknown {
    const fk = foreignKeyFor(cfg, field);
    const isObj = value !== null && typeof value === 'object';
    if (isObj && 'ref' in value) {
      if (!fk) { problems.push(`${at(i, r)}: ${field} is not a foreign key, so it cannot take a ref`); return undefined; }
      const target = byRef.get(value.ref);
      if (!target) { problems.push(`${at(i, r)}: ${field} refers to '${value.ref}', which is not a ref in this plan`); return undefined; }
      if (!lineageOf(domain, target.record.entity).includes(fk.targetEntity)) {
        problems.push(`${at(i, r)}: ${field} points at ${fk.targetEntity}, but '${value.ref}' is a ${target.record.entity}`);
        return undefined;
      }
      return rows[target.index]![fk.targetField ?? 'ID'];
    }
    if (isObj && 'lookup' in value) {
      if (!fk) { problems.push(`${at(i, r)}: ${field} is not a foreign key, so it cannot take a lookup`); return undefined; }
      const targetCfg = domain.entities[fk.targetEntity];
      const unknown = Object.keys(value.lookup).filter((k) => !targetCfg?.fields[k]);
      if (unknown.length) { problems.push(`${at(i, r)}: ${field} lookup names ${unknown.join(', ')}, not fields of ${fk.targetEntity}`); return undefined; }
      const matches = pool(fk.targetEntity).filter((row) => Object.entries(value.lookup).every(([k, v]) => String(row[k]) === String(v)));
      const desc = Object.entries(value.lookup).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
      if (matches.length !== 1) {
        problems.push(`${at(i, r)}: ${field} lookup ${fk.targetEntity} where ${desc} matched ${matches.length} records (needs exactly 1)`);
        return undefined;
      }
      return matches[0]![fk.targetField ?? 'ID'];
    }
    if (fk && value !== null) {
      const id = String(value).toLowerCase();
      const exists = pool(fk.targetEntity).some((row) => keyOf(row, fk.targetField ?? 'ID').toLowerCase() === id);
      if (!exists) { problems.push(`${at(i, r)}: ${field} = ${JSON.stringify(value)} is not a ${fk.targetEntity} key; use a ref or a lookup`); return undefined; }
      return value;
    }
    const type = cfg.fields[field]!.type;
    const ok = value === null
      || (type === 'number' && typeof value === 'number')
      || (type === 'boolean' && typeof value === 'boolean')
      || (type === 'date' && typeof value === 'string' && DATE_REGEX.test(value))
      || (type === 'uuid' && typeof value === 'string' && UUID_REGEX.test(value))
      || (type !== 'number' && type !== 'boolean' && type !== 'date' && type !== 'uuid' && typeof value === 'string');
    if (!ok) { problems.push(`${at(i, r)}: ${entity}.${field} is a ${type}, got ${JSON.stringify(value)}`); return undefined; }
    return value;
  }

  if (problems.length) throw planError(problems);

  // ── 5. Append ──
  const added: Record<string, number> = {};
  const supplied = new Map<Record<string, unknown>, Set<string>>();
  plan.records.forEach((r, i) => {
    if (!records[r.entity]) records[r.entity] = [];
    records[r.entity]!.push(rows[i]!);
    added[r.entity] = (added[r.entity] ?? 0) + 1;
    supplied.set(rows[i]!, new Set(Object.keys(r.fields)));
  });
  return { added, supplied, nulled: Object.fromEntries(Object.entries(nulled).map(([e, f]) => [e, [...f].sort()])) };
}

function planError(problems: string[]): Error {
  return new Error(`Accumulate plan rejected (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n  ${problems.join('\n  ')}`);
}
