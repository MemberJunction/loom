import { createRng } from '../math/rng.js';
import { sigmoid, calibrateIntercept } from '../math/calibration.js';

export interface RecurringDecisionOptions<TItem, TCtx = unknown> {
  seed: number;
  cycles: readonly number[];
  cohortOf: (cycle: number) => readonly TItem[];
  prepareCohortContext?: (cohort: readonly TItem[], cycle: number) => TCtx;
  scoreOf: (item: TItem, cycle: number, ctx?: TCtx) => number;
  target: number; // Target rate per cycle
  streamKey: (item: TItem, cycle: number) => string;
  baselineShift?: (cycle: number) => number;
  pinnedDecision?: (item: TItem, cycle: number) => boolean | null | undefined;
  onDecision: (item: TItem, cycle: number, decidedYes: boolean, ctx?: TCtx) => void;
}

/**
 * Pattern 2: recurringDecision
 * Per cycle, an eligible cohort faces a calibrated binary decision with state consequences.
 */
export function recurringDecision<TItem, TCtx>(
  opts: RecurringDecisionOptions<TItem, TCtx>
): void {
  for (const cycle of opts.cycles) {
    const cohort = opts.cohortOf(cycle);
    if (!cohort || cohort.length === 0) continue;

    const ctx = opts.prepareCohortContext ? opts.prepareCohortContext(cohort, cycle) : undefined;
    const scores = cohort.map((item) => opts.scoreOf(item, cycle, ctx));
    const b0 = calibrateIntercept(scores, opts.target) + (opts.baselineShift?.(cycle) ?? 0);

    for (let i = 0; i < cohort.length; i++) {
      const item = cohort[i]!;
      const score = scores[i] ?? 0;
      const pinned = opts.pinnedDecision?.(item, cycle);

      let decidedYes: boolean;
      if (typeof pinned === 'boolean') {
        decidedYes = pinned;
      } else {
        const rng = createRng(opts.seed, opts.streamKey(item, cycle));
        decidedYes = rng.bernoulli(sigmoid(b0 + score));
      }

      opts.onDecision(item, cycle, decidedYes, ctx);
    }
  }
}
