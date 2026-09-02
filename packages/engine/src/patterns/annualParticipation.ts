import { createRng, type RngStream } from '../math/rng.js';
import { sigmoid, calibrateIntercept } from '../math/calibration.js';

export interface AnnualParticipationOptions<TEntity, TSpawned> {
  seed: number;
  years: readonly number[];
  poolOf: (year: number) => readonly TEntity[];
  scoreOf: (entity: TEntity, year: number) => number;
  target: number; // Desired annual participation rate in (0, 1)
  streamKey: (entity: TEntity, year: number) => string;
  spawn: (rng: RngStream, entity: TEntity, year: number) => TSpawned | readonly TSpawned[] | null;
  minPool?: number;
  baselineShift?: (year: number) => number;
}

/**
 * Pattern 1: annualParticipation
 * Each year, an eligible pool faces a calibrated yes/no decision.
 * Participants spawn child records.
 */
export function annualParticipation<TEntity, TSpawned>(
  opts: AnnualParticipationOptions<TEntity, TSpawned>
): TSpawned[] {
  const spawnedRecords: TSpawned[] = [];
  const minPool = opts.minPool ?? 5;

  for (const year of opts.years) {
    const pool = opts.poolOf(year);
    if (!pool || pool.length < minPool) continue;

    const scores = pool.map((entity) => opts.scoreOf(entity, year));
    const b0 = calibrateIntercept(scores, opts.target) + (opts.baselineShift?.(year) ?? 0);

    for (let i = 0; i < pool.length; i++) {
      const entity = pool[i]!;
      const score = scores[i] ?? 0;
      const rng = createRng(opts.seed, opts.streamKey(entity, year));

      const participated = rng.bernoulli(sigmoid(b0 + score));
      if (!participated) continue;

      const result = opts.spawn(rng, entity, year);
      if (result) {
        if (Array.isArray(result)) {
          spawnedRecords.push(...result);
        } else {
          spawnedRecords.push(result as TSpawned);
        }
      }
    }
  }

  return spawnedRecords;
}
