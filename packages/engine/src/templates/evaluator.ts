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

export type SequenceState = Record<string, number>;

/**
 * Evaluates a single field specification against a local scope, optional PRNG stream,
 * and sequence tracking state.
 */
function evalField(
  fs: FieldSpec,
  scope: Record<string, unknown>,
  rng?: RngStream,
  seqState?: SequenceState
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
    if (!seqState) {
      throw new Error(`evalField: sequence counter '${fs.seq}' requires a SequenceState`);
    }
    const current = (seqState[fs.seq] ?? 0) + 1;
    seqState[fs.seq] = current;
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
 * Never mutates the caller's scope object.
 */
export function renderRow(
  template: RowTemplate,
  scope: Record<string, unknown>,
  rng?: RngStream,
  seqState?: SequenceState
): Record<string, unknown> {
  // Pure local scope for let-bindings — caller scope is never mutated
  const localScope: Record<string, unknown> = { ...scope };

  // 1. Evaluate pre-bindings in `let`
  if (template.let) {
    for (const [key, spec] of Object.entries(template.let)) {
      localScope[key] = evalField(spec, localScope, rng, seqState);
    }
  }

  // 2. Evaluate row fields
  const output: Record<string, unknown> = {};
  for (const [fieldName, spec] of Object.entries(template.row)) {
    output[fieldName] = evalField(spec, localScope, rng, seqState);
  }

  return output;
}
