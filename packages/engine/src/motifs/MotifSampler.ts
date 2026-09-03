import type {
  MotifConfig,
  MotifQuota,
  LatentTrajectory,
  ChildRate,
  FactorOverride,
} from '@memberjunction/loom-contracts';
import { RngStream } from '../math/rng.js';

export interface EntityCandidate {
  id: string;
  entity: string;
  birthCycle: number;
  latentDials: Record<string, number>;
  isHero: boolean;
  motifs?: string[];
  fixedFields?: Record<string, string | number | boolean | null>;
}

export interface MotifAssignment {
  entityId: string;
  motifKey: string;
  eras: string[];
  latentTrajectory?: LatentTrajectory;
  childRates: ChildRate[];
  factorOverrides: FactorOverride[];
  ladderProgression?: {
    ladderKey: string;
    initialState: string;
  };
}

/**
 * Samples and assigns parameterized storyline motifs across non-hero population cohorts.
 * Enforces Invariant 3: Motif quota exactness.
 */
export class MotifSampler {
  private motifs = new Map<string, MotifConfig>();

  constructor(motifConfigs: MotifConfig[] = []) {
    for (const config of motifConfigs) {
      this.RegisterMotif(config);
    }
  }

  public RegisterMotif(config: MotifConfig): void {
    this.motifs.set(config.motifKey, config);
  }

  public GetMotif(motifKey: string): MotifConfig | undefined {
    return this.motifs.get(motifKey);
  }

  public GetAllMotifs(): MotifConfig[] {
    return Array.from(this.motifs.values());
  }

  /**
   * Calculates the exact quota target count for a motif given total entity population size.
   */
  public CalculateTargetCount(quota: MotifQuota, totalCount: number): number {
    if (quota.mode === 'count') {
      return Math.min(totalCount, Math.round(quota.value));
    }

    const raw = quota.value * totalCount;
    switch (quota.rounding) {
      case 'floor':
        return Math.floor(raw);
      case 'ceil':
        return Math.ceil(raw);
      case 'round':
      default:
        return Math.round(raw);
    }
  }

  /**
   * Samples motifs across the population according to configured quotas and latent constraints.
   */
  public SamplePopulation(
    population: EntityCandidate[],
    rng: RngStream
  ): Map<string, MotifAssignment[]> {
    const assignmentsByEntity = new Map<string, MotifAssignment[]>();

    for (const motif of this.motifs.values()) {
      // 1. Filter candidates
      const matching = population.filter((candidate) => {
        if (candidate.isHero) return false;
        if (candidate.entity !== motif.targetEntity) return false;

        // Check birth cycles if specified
        if (motif.birthCycles && !motif.birthCycles.includes(candidate.birthCycle)) {
          return false;
        }

        // Check latent constraints if specified
        if (motif.latentConstraints) {
          for (const [dial, bounds] of Object.entries(motif.latentConstraints)) {
            const val = candidate.latentDials[dial];
            if (val === undefined) return false;
            if (bounds.min !== undefined && val < bounds.min) return false;
            if (bounds.max !== undefined && val > bounds.max) return false;
          }
        }

        return true;
      });

      const totalTargetPopulation = population.filter(
        (c) => !c.isHero && c.entity === motif.targetEntity
      ).length;

      const targetCount = this.CalculateTargetCount(motif.quota, totalTargetPopulation);
      const sampleCount = Math.min(matching.length, targetCount);

      // 2. Sample without replacement using Fisher-Yates shuffle via PRNG
      const shuffled = [...matching];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        const temp = shuffled[i]!;
        shuffled[i] = shuffled[j]!;
        shuffled[j] = temp;
      }

      const selected = shuffled.slice(0, sampleCount);

      // 3. Record assignments and apply fixedFields
      for (const entity of selected) {
        if (!entity.motifs) entity.motifs = [];
        entity.motifs.push(motif.motifKey);

        if (motif.fixedFields) {
          if (!entity.fixedFields) entity.fixedFields = {};
          Object.assign(entity.fixedFields, motif.fixedFields);
        }

        const assignment: MotifAssignment = {
          entityId: entity.id,
          motifKey: motif.motifKey,
          eras: [...(motif.eras ?? [])],
          latentTrajectory: motif.latentTrajectory,
          childRates: [...(motif.childRates ?? [])],
          factorOverrides: [...(motif.factorOverrides ?? [])],
          ladderProgression: motif.ladderProgression,
        };

        const existing = assignmentsByEntity.get(entity.id) ?? [];
        existing.push(assignment);
        assignmentsByEntity.set(entity.id, existing);
      }
    }

    return assignmentsByEntity;
  }
}
