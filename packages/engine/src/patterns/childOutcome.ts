import { createRng } from '../math/rng.js';
import { sigmoid, calibrateIntercept } from '../math/calibration.js';

export interface ChildOutcomeOptions<TParent, TOutcome> {
  seed: number;
  parents: readonly TParent[];
  scoreOf: (parent: TParent) => number;
  target: number; // Share of parents receiving positive outcome
  streamKey: (parent: TParent) => string;
  onPositive: (parent: TParent) => TOutcome;
  onNegative?: (parent: TParent) => TOutcome;
}

/**
 * Pattern 3: childOutcome
 * Per parent record, assigns a calibrated binary outcome.
 */
export function childOutcome<TParent, TOutcome>(
  opts: ChildOutcomeOptions<TParent, TOutcome>
): TOutcome[] {
  if (opts.parents.length === 0) return [];

  const scores = opts.parents.map((p) => opts.scoreOf(p));
  const b0 = calibrateIntercept(scores, opts.target);
  const outcomes: TOutcome[] = [];

  for (let i = 0; i < opts.parents.length; i++) {
    const parent = opts.parents[i]!;
    const score = scores[i] ?? 0;
    const rng = createRng(opts.seed, opts.streamKey(parent));

    const isPositive = rng.bernoulli(sigmoid(b0 + score));
    if (isPositive) {
      outcomes.push(opts.onPositive(parent));
    } else if (opts.onNegative) {
      outcomes.push(opts.onNegative(parent));
    }
  }

  return outcomes;
}
