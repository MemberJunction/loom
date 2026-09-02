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
    const key = `__seq_${fs.seq}`;
    const current = typeof scope[key] === 'number'
      ? (scope[key] as number) + 1
      : (typeof scope[fs.seq] === 'number' ? (scope[fs.seq] as number) + 1 : 1);
    scope[key] = current;
    scope[fs.seq] = current;
    return current;
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
    let p: number;
    if (typeof fs.chance === 'number') {
      p = fs.chance;
    } else {
      const resolved = resolveDotPath(scope, fs.chance);
      if (resolved === undefined || resolved === null) {
        throw new Error(`evalField: chance path '${fs.chance}' resolved to undefined/null`);
      }
      p = Number(resolved);
      if (isNaN(p)) {
        throw new Error(`evalField: chance path '${fs.chance}' resolved to non-numeric value: ${resolved}`);
      }
    }
    if (p < 0 || p > 1) {
      throw new Error(`evalField: chance probability must be within [0, 1], received ${p}`);
    }
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
  // 1. Evaluate pre-bindings in `let`
  if (template.let) {
    for (const [key, spec] of Object.entries(template.let)) {
      scope[key] = evalField(spec, scope, rng);
    }
  }

  // 2. Evaluate row fields
  const output: Record<string, unknown> = {};
  for (const [fieldName, spec] of Object.entries(template.row)) {
    output[fieldName] = evalField(spec, scope, rng);
  }

  return output;
}
