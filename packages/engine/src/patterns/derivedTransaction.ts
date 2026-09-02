import { createRng, type RngStream } from '../math/rng.js';

export type TimingDistribution =
  | { type: 'const'; days: number }
  | { type: 'uniformDays'; min: number; max: number }
  | { type: 'lognormalDays'; medianDays: number; sigma: number; minDays?: number; capDays?: number }
  | { type: 'mixture'; bands: readonly [TimingDistribution, number][] };

export interface DerivedTransactionOptions<TParent, TTransaction> {
  seed: number;
  parents: readonly TParent[];
  streamKey: (parent: TParent) => string;
  timing: TimingDistribution;
  createTransaction: (rng: RngStream, parent: TParent, offsetDays: number) => TTransaction;
}

/**
 * Draws offset days from a declared timing distribution.
 */
export function drawOffsetDays(rng: RngStream, dist: TimingDistribution): number {
  switch (dist.type) {
    case 'const':
      return dist.days;
    case 'uniformDays':
      return rng.int(dist.min, dist.max);
    case 'lognormalDays': {
      const z = rng.normal(0, 1);
      const days = Math.round(dist.medianDays * Math.exp(z * dist.sigma));
      const clampedMin = dist.minDays !== undefined ? Math.max(dist.minDays, days) : days;
      return dist.capDays !== undefined ? Math.min(dist.capDays, clampedMin) : clampedMin;
    }
    case 'mixture': {
      const options = dist.bands.map(([bandDist, weight]) => ({
        value: bandDist,
        weight,
      }));
      const chosenBand = rng.pickWeighted(options);
      return drawOffsetDays(rng, chosenBand);
    }
  }
}

/**
 * Pattern 4: derivedTransaction
 * Emits transactional child rows with offset timing distributions.
 */
export function derivedTransaction<TParent, TTransaction>(
  opts: DerivedTransactionOptions<TParent, TTransaction>
): TTransaction[] {
  const transactions: TTransaction[] = [];

  for (const parent of opts.parents) {
    const rng = createRng(opts.seed, opts.streamKey(parent));
    const offsetDays = drawOffsetDays(rng, opts.timing);
    transactions.push(opts.createTransaction(rng, parent, offsetDays));
  }

  return transactions;
}
