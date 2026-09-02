import type { FactorContract, LatentDialConfig } from '@memberjunction/loom-contracts';
import { RngStream } from '../math/rng.js';

export interface LatentProfile {
  entityId: string;
  dials: Record<string, number>;
}

/**
 * Manages continuous latent dials (engagement theta, affluence phi, etc.)
 * and evaluates factor contracts.
 */
export class FactorEngine {
  private dialConfigs = new Map<string, LatentDialConfig>();

  public registerDial(config: LatentDialConfig): void {
    this.dialConfigs.set(config.name, config);
  }

  /**
   * Initializes latent dials for an entity record using seeded PRNG.
   */
  public initializeProfile(rng: RngStream, entityId: string): LatentProfile {
    const dials: Record<string, number> = {};

    for (const [name, cfg] of this.dialConfigs.entries()) {
      // Draw initial anchor from normal distribution
      dials[name] = rng.normal(cfg.mean, cfg.stdDev);
    }

    // Apply simple pairwise correlation adjustments if configured
    for (const [name, cfg] of this.dialConfigs.entries()) {
      for (const [otherDial, corr] of Object.entries(cfg.correlations)) {
        if (dials[otherDial] !== undefined && dials[name] !== undefined) {
          // Adjust dial towards correlated dial
          dials[name] = dials[name]! * Math.sqrt(1 - corr * corr) + dials[otherDial]! * corr;
        }
      }
    }

    return { entityId, dials };
  }

  /**
   * Advances an entity's latent dials across a simulation period via random walk.
   */
  public advanceProfile(
    rng: RngStream,
    profile: LatentProfile,
    elapsedYears = 1
  ): LatentProfile {
    const updatedDials: Record<string, number> = { ...profile.dials };

    for (const [name, cfg] of this.dialConfigs.entries()) {
      const current = updatedDials[name] ?? cfg.mean;
      const stepStdDev = cfg.annualWanderStdDev * Math.sqrt(elapsedYears);
      const wander = rng.normal(0, stepStdDev);
      updatedDials[name] = current + wander;
    }

    return {
      entityId: profile.entityId,
      dials: updatedDials,
    };
  }

  /**
   * Computes the linear logit score for an entity given a factor contract
   * and a compiled feature extractor.
   */
  public computeScore(
    contract: FactorContract,
    featureValues: Record<string, number>
  ): number {
    let score = 0;
    for (const [arrowName, arrow] of Object.entries(contract.arrows)) {
      const val = featureValues[arrowName] ?? 0;
      score += arrow.beta * val;
    }
    return score;
  }
}
