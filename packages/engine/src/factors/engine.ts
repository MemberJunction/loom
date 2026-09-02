import type { FactorContract, LatentDialConfig } from '@memberjunction/loom-contracts';
import { RngStream } from '../math/rng.js';

export interface LatentProfile {
  entityId: string;
  dials: Record<string, number>;
}

/**
 * Manages continuous latent dials (engagement theta, affluence phi, etc.)
 * and evaluates factor contracts using Cholesky decomposition for exact correlations.
 */
export class FactorEngine {
  private dialConfigs = new Map<string, LatentDialConfig>();

  public RegisterDial(config: LatentDialConfig): void {
    this.dialConfigs.set(config.name, config);
  }
  public registerDial(config: LatentDialConfig): void {
    this.RegisterDial(config);
  }

  /**
   * Initializes latent dials for an entity record using seeded PRNG.
   * Employs Cholesky decomposition on standard normal draws to guarantee
   * exact target means, standard deviations, and correlation coefficients.
   */
  public InitializeProfile(rng: RngStream, entityId: string): LatentProfile {
    const dialNames = Array.from(this.dialConfigs.keys());
    const m = dialNames.length;
    const dials: Record<string, number> = {};

    if (m === 0) {
      return { entityId, dials };
    }

    // 1. Build symmetric correlation matrix R
    const R: number[][] = Array.from({ length: m }, () => Array(m).fill(0));
    for (let i = 0; i < m; i++) {
      R[i]![i] = 1;
      const cfgI = this.dialConfigs.get(dialNames[i]!)!;
      for (let j = 0; j < i; j++) {
        const nameJ = dialNames[j]!;
        const corr = cfgI.correlations[nameJ] ?? this.dialConfigs.get(nameJ)?.correlations[dialNames[i]!] ?? 0;
        // Clamp to [-0.999, 0.999] for numerical stability
        const safeCorr = Math.max(-0.999, Math.min(0.999, corr));
        R[i]![j] = safeCorr;
        R[j]![i] = safeCorr;
      }
    }

    // 2. Cholesky decomposition: compute lower triangular L such that L * L^T = R
    const L: number[][] = Array.from({ length: m }, () => Array(m).fill(0));
    for (let i = 0; i < m; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = 0;
        for (let k = 0; k < j; k++) {
          sum += L[i]![k]! * L[j]![k]!;
        }
        if (i === j) {
          const val = R[i]![i]! - sum;
          L[i]![j] = Math.sqrt(Math.max(1e-12, val));
        } else {
          L[i]![j] = (R[i]![j]! - sum) / L[j]![j]!;
        }
      }
    }

    // 3. Draw independent standard normal variates Z ~ N(0, 1)
    const Z = dialNames.map(() => rng.normal(0, 1));

    // 4. Correlate in standard z-score space: Y = L * Z
    const Y: number[] = new Array(m).fill(0);
    for (let i = 0; i < m; i++) {
      let acc = 0;
      for (let k = 0; k <= i; k++) {
        acc += L[i]![k]! * Z[k]!;
      }
      Y[i] = acc;
    }

    // 5. Shift and scale: dial = mean + stdDev * Y
    for (let i = 0; i < m; i++) {
      const name = dialNames[i]!;
      const cfg = this.dialConfigs.get(name)!;
      dials[name] = cfg.mean + cfg.stdDev * Y[i]!;
    }

    return { entityId, dials };
  }
  public initializeProfile(rng: RngStream, entityId: string): LatentProfile {
    return this.InitializeProfile(rng, entityId);
  }

  /**
   * Advances an entity's latent dials across a simulation period via random walk.
   */
  public AdvanceProfile(
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
  public advanceProfile(
    rng: RngStream,
    profile: LatentProfile,
    elapsedYears = 1
  ): LatentProfile {
    return this.AdvanceProfile(rng, profile, elapsedYears);
  }

  /**
   * Computes the linear logit score for an entity given a factor contract
   * and feature values.
   */
  public ComputeScore(
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
  public computeScore(
    contract: FactorContract,
    featureValues: Record<string, number>
  ): number {
    return this.ComputeScore(contract, featureValues);
  }
}
