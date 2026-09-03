import type {
  EraConfig,
  FactorContract,
} from '@memberjunction/loom-contracts';
import { RngStream } from '../math/rng.js';
import { HeroInjector } from '../heroes/HeroInjector.js';
import { MotifSampler, EntityCandidate, MotifAssignment } from '../motifs/MotifSampler.js';
import { StateLadderEngine } from '../ladders/StateLadderEngine.js';

export interface UnrollEntityState {
  id: string;
  entity: string;
  birthCycle: number;
  isHero: boolean;
  heroKey?: string;
  motifs: string[];
  latentDials: Record<string, number>;
  fixedFields: Record<string, string | number | boolean | null>;
  outcomesByCycle: Map<number, Record<string, boolean>>; // cycle -> factorId -> outcome
  ladderStates: Record<string, string>; // ladderKey -> currentState
}

export interface UnrollConfig {
  totalCycles: number;
  entities: EntityCandidate[];
  heroInjector: HeroInjector;
  motifSampler: MotifSampler;
  ladderEngine: StateLadderEngine;
  eras?: EraConfig[];
  factorContracts?: FactorContract[];
  annualWanderStdDev?: number;
}

export interface CycleSnapshot {
  cycle: number;
  activePopulation: number;
  activeEras: string[];
  outcomesCount: Record<string, number>;
}

/**
 * Retrospective multi-cycle simulation orchestrator.
 * Evaluates historical cycles from cycle 0 through C - 1, handling AR(1) drift,
 * macroeconomic era intercepts, ladder progression, motif trajectories, and hero pins.
 */
export class RetrospectiveUnroller {
  private entityStates = new Map<string, UnrollEntityState>();
  private motifAssignments = new Map<string, MotifAssignment[]>();

  constructor(private config: UnrollConfig) {}

  /**
   * Initializes all entity states, hero overrides, and motif assignments.
   */
  public Initialize(rng: RngStream): void {
    const { entities, heroInjector, motifSampler, ladderEngine } = this.config;

    // 1. Register heroes into state
    for (const hero of heroInjector.GetAllHeroes()) {
      const heroState: UnrollEntityState = {
        id: hero.id,
        entity: hero.entity,
        birthCycle: hero.birthCycle,
        isHero: true,
        heroKey: hero.heroKey,
        motifs: [],
        latentDials: { ...hero.latentDials },
        fixedFields: { ...hero.fixedFields },
        outcomesByCycle: new Map(),
        ladderStates: {},
      };

      // Enroll in initial ladder entries
      for (const entry of hero.ladderEntries) {
        ladderEngine.Enroll(entry.ladderKey, hero.id, entry.state, entry.enterCycle);
        heroState.ladderStates[entry.ladderKey] = entry.state;
      }

      this.entityStates.set(hero.id, heroState);
    }

    // 2. Register non-hero population
    for (const cand of entities) {
      if (cand.isHero) continue;
      const state: UnrollEntityState = {
        id: cand.id,
        entity: cand.entity,
        birthCycle: cand.birthCycle,
        isHero: false,
        motifs: [],
        latentDials: { ...cand.latentDials },
        fixedFields: { ...cand.fixedFields },
        outcomesByCycle: new Map(),
        ladderStates: {},
      };
      this.entityStates.set(cand.id, state);
    }

    // 3. Sample and assign motifs across non-hero population
    this.motifAssignments = motifSampler.SamplePopulation(entities, rng);

    // Apply initial motif ladder progressions
    for (const [entityId, assignments] of this.motifAssignments.entries()) {
      const state = this.entityStates.get(entityId);
      if (!state) continue;

      for (const a of assignments) {
        state.motifs.push(a.motifKey);
        if (a.ladderProgression) {
          ladderEngine.Enroll(
            a.ladderProgression.ladderKey,
            entityId,
            a.ladderProgression.initialState,
            state.birthCycle
          );
          state.ladderStates[a.ladderProgression.ladderKey] = a.ladderProgression.initialState;
        }
      }
    }
  }

  /**
   * Runs the multi-cycle retrospective simulation.
   */
  public Run(rng: RngStream): CycleSnapshot[] {
    const snapshots: CycleSnapshot[] = [];
    const wanderStdDev = this.config.annualWanderStdDev ?? 0.15;
    const wanderCoeff = Math.sqrt(Math.max(0, 1 - wanderStdDev * wanderStdDev));

    for (let c = 0; c < this.config.totalCycles; c++) {
      // 1. Identify active eras for cycle c
      const activeEras = (this.config.eras ?? []).filter((era) => era.cycles.includes(c));
      const eraFactorAdjustments = new Map<string, number>();
      for (const era of activeEras) {
        for (const adj of era.factorAdjustments) {
          const prev = eraFactorAdjustments.get(adj.factor) ?? 0;
          eraFactorAdjustments.set(adj.factor, prev + adj.deltaIntercept);
        }
      }

      let activeCount = 0;
      const outcomesCount: Record<string, number> = {};

      // 2. Advance each entity
      for (const entity of this.entityStates.values()) {
        if (c < entity.birthCycle) {
          continue; // Entity not born yet
        }
        activeCount++;
        const cyclesSinceBirth = c - entity.birthCycle;

        // A. Advance latent dials
        const assignments = this.motifAssignments.get(entity.id) ?? [];
        for (const [dialName, currentVal] of Object.entries(entity.latentDials)) {
          // Check if any motif specifies a deterministic trajectory for this dial
          const trajectory = assignments.find((a) => a.latentTrajectory?.dial === dialName)?.latentTrajectory;
          if (trajectory) {
            entity.latentDials[dialName] = currentVal + trajectory.deltaPerCycle;
          } else {
            // Apply AR(1) wander
            const shock = rng.normal();
            entity.latentDials[dialName] = currentVal * wanderCoeff + shock * wanderStdDev;
          }
        }

        // B. Step ladders
        for (const ladder of this.config.ladderEngine.GetAllLadders()) {
          const stepResult = this.config.ladderEngine.StepEntity(ladder.ladderKey, entity.id, {
            cycle: c,
            cyclesSinceBirth,
            latentDials: entity.latentDials,
          });

          if (stepResult.newState) {
            entity.ladderStates[ladder.ladderKey] = stepResult.newState;
          } else if (stepResult.transitioned && !stepResult.newState) {
            delete entity.ladderStates[ladder.ladderKey];
          }

          // Apply exit effects to dials
          for (const exitEffect of stepResult.exitEffects) {
            const cur = entity.latentDials[exitEffect.dial] ?? 0;
            entity.latentDials[exitEffect.dial] = cur + exitEffect.delta;
          }
        }

        // C. Evaluate factors for this cycle
        const cycleOutcomes: Record<string, boolean> = {};
        for (const contract of this.config.factorContracts ?? []) {
          let realizedOutcome: boolean;

          // 1. Check Hero outcome pins (Invariant 2)
          if (entity.isHero && entity.heroKey) {
            const pinned = this.config.heroInjector.GetOutcomePin(entity.heroKey, contract.id, c);
            if (pinned !== undefined) {
              realizedOutcome = pinned;
              cycleOutcomes[contract.id] = realizedOutcome;
              if (realizedOutcome) outcomesCount[contract.id] = (outcomesCount[contract.id] ?? 0) + 1;
              continue;
            }
          }

          // 2. Check Motif factor overrides
          let overrideProb: number | undefined;
          let overrideBeta: number | undefined;
          for (const a of assignments) {
            const fo = a.factorOverrides.find((o) => o.factor === contract.id);
            if (fo) {
              if (fo.probability !== undefined) overrideProb = fo.probability;
              if (fo.beta !== undefined) overrideBeta = fo.beta;
            }
          }

          if (overrideProb !== undefined) {
            realizedOutcome = rng.next() < overrideProb;
          } else {
            // Evaluate standard logit model with era intercept adjustment
            let logit = Math.log(contract.target / (1 - Math.max(1e-5, contract.target)));
            logit += eraFactorAdjustments.get(contract.id) ?? 0;

            // Add dial effects
            for (const arrow of Object.values(contract.arrows)) {
              const dialVal = entity.latentDials[arrow.name] ?? 0;
              const beta = overrideBeta !== undefined ? overrideBeta : arrow.beta;
              logit += beta * dialVal;
            }

            const prob = 1 / (1 + Math.exp(-logit));
            realizedOutcome = rng.next() < prob;
          }

          cycleOutcomes[contract.id] = realizedOutcome;
          if (realizedOutcome) {
            outcomesCount[contract.id] = (outcomesCount[contract.id] ?? 0) + 1;
          }
        }

        entity.outcomesByCycle.set(c, cycleOutcomes);
      }

      snapshots.push({
        cycle: c,
        activePopulation: activeCount,
        activeEras: activeEras.map((e) => e.eraKey),
        outcomesCount,
      });
    }

    return snapshots;
  }

  public GetEntityState(entityId: string): UnrollEntityState | undefined {
    return this.entityStates.get(entityId);
  }

  public GetAllEntityStates(): UnrollEntityState[] {
    return Array.from(this.entityStates.values());
  }
}
