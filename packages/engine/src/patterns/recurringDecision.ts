import { createRng } from '../math/rng.js';
import { sigmoid, calibrateIntercept } from '../math/calibration.js';

export interface RecurringDecisionOptions<TCandidate, TCtx = unknown> {
  seed: number;
  cycles: readonly number[];
  cohortOf: (cycle: number) => readonly TCandidate[];
  prepareCohortContext?: (cohort: readonly TCandidate[], cycle: number) => TCtx;
  scoreOf: (candidate: TCandidate, cycle: number, ctx?: TCtx) => number;
  target: number; // Target rate per cycle
  streamKey: (candidate: TCandidate, cycle: number) => string;
  baselineShift?: (cycle: number) => number;
  pinnedDecision?: (candidate: TCandidate, cycle: number) => boolean | null | undefined;
  onDecision: (candidate: TCandidate, cycle: number, decidedYes: boolean, ctx?: TCtx) => void;
}

/**
 * Pattern 2: recurringDecision
 * Per cycle, an eligible cohort faces a calibrated binary choice with state consequences.
 */
export function recurringDecision<TCandidate, TCtx>(
  opts: RecurringDecisionOptions<TCandidate, TCtx>
): void {
  for (const cycle of opts.cycles) {
    const cohort = opts.cohortOf(cycle);
    if (!cohort || cohort.length === 0) continue;

    const ctx = opts.prepareCohortContext ? opts.prepareCohortContext(cohort, cycle) : undefined;
    const scores = cohort.map((candidate) => opts.scoreOf(candidate, cycle, ctx));
    const b0 = calibrateIntercept(scores, opts.target) + (opts.baselineShift?.(cycle) ?? 0);

    for (let i = 0; i < cohort.length; i++) {
      const candidate = cohort[i]!;
      const score = scores[i] ?? 0;
      const pinned = opts.pinnedDecision?.(candidate, cycle);

      let decidedYes: boolean;
      if (typeof pinned === 'boolean') {
        decidedYes = pinned;
      } else {
        const rng = createRng(opts.seed, opts.streamKey(candidate, cycle));
        decidedYes = rng.bernoulli(sigmoid(b0 + score));
      }

      opts.onDecision(candidate, cycle, decidedYes, ctx);
    }
  }
}
