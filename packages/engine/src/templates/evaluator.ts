import { RngStream } from '../math/rng.js';

export type FieldSpec =
  | string
  | number
  | boolean
  | null
  | { const: unknown }
  | { from: string }
  | { fromOptional: string }
  | { fmt: string }
  | { pick: string }
  | { mix: string }
  | { chance: number | string }
  | { int: [number, number] }
  | { seq: string };

export interface RowTemplate {
  let?: Record<string, FieldSpec>;
  row: Record<string, FieldSpec>;
}

/**
 * Evaluates a single field specification against the scope and optional PRNG stream.
 */
function evalField(
  fs: FieldSpec,
  scope: Record<string, unknown>,
  rng?: RngStream
): unknown {
  if (fs === null || typeof fs !== 'object') {
    return fs;
  }

  if ('const' in fs) return fs.const;

  if ('from' in fs) {
    const val = resolveDotPath(scope, fs.from);
    if (val === undefined) {
      throw new Error(`evalField: required path '${fs.from}' resolved to undefined`);
    }
    return val;
  }

  if ('fromOptional' in fs) {
    const val = resolveDotPath(scope, fs.fromOptional);
    return val ?? null;
  }

  if ('fmt' in fs) {
    return fs.fmt.replace(/\{([^}]+)\}/g, (_, path: string) => {
      const val = resolveDotPath(scope, path.trim());
      return val !== undefined ? String(val) : '';
    });
  }

  if ('seq' in fs) {
    const counter = scope[fs.seq];
    return typeof counter === 'number' ? counter : 0;
  }

  // The remaining tags require an RNG handle
  if (!rng) {
    throw new Error(`evalField: probabilistic tag requires an active RngStream`);
  }

  if ('pick' in fs) {
    const pool = resolveDotPath(scope, fs.pick);
    if (!Array.isArray(pool) || pool.length === 0) {
      throw new Error(`evalField: pick target '${fs.pick}' must be a non-empty array`);
    }
    return rng.pick(pool);
  }

  if ('mix' in fs) {
    const mixOptions = resolveDotPath(scope, fs.mix);
    if (!Array.isArray(mixOptions) || mixOptions.length === 0) {
      throw new Error(`evalField: mix target '${fs.mix}' must be a non-empty array of options`);
    }
    return rng.pickWeighted(mixOptions as readonly { value: unknown; weight: number }[]);
  }

  if ('chance' in fs) {
    const p = typeof fs.chance === 'number' ? fs.chance : Number(resolveDotPath(scope, fs.chance));
    return rng.bernoulli(p);
  }

  if ('int' in fs) {
    const [min, max] = fs.int;
    return rng.int(min, max);
  }

  return fs;
}

/**
 * Resolves a dot-path (e.g. 'member.profile.address.city') from a scope object.
 */
function resolveDotPath(scope: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let curr: unknown = scope;
  for (const part of parts) {
    if (!curr || typeof curr !== 'object') return undefined;
    curr = (curr as Record<string, unknown>)[part];
  }
  return curr;
}

/**
 * Renders one entity record from a declarative RowTemplate.
 */
export function renderRow(
  template: RowTemplate,
  scope: Record<string, unknown>,
  rng?: RngStream
): Record<string, unknown> {
  const localScope: Record<string, unknown> = { ...scope };

  // 1. Evaluate pre-bindings in `let`
  if (template.let) {
    for (const [key, spec] of Object.entries(template.let)) {
      localScope[key] = evalField(spec, localScope, rng);
    }
  }

  // 2. Render output columns in `row`
  const result: Record<string, unknown> = {};
  for (const [col, spec] of Object.entries(template.row)) {
    result[col] = evalField(spec, localScope, rng);
  }

  return result;
}
