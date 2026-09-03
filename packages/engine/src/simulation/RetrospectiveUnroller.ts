import type {
  DomainConfig,
  EraConfig,
  FactorContract,
} from '@memberjunction/loom-contracts';
import { RngStream } from '../math/rng.js';
import { calibrateIntercept, sigmoid } from '../math/calibration.js';
import { FactorEngine, type LatentProfile } from '../factors/engine.js';
import {
  compileFeature,
  type FeatureEvaluator,
  type RelationalContext,
  type EntityRecord,
} from '../features/compiler.js';
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
  /** Array of absolute cycles to simulate (e.g. [2021, 2022, 2023, 2024, 2025, 2026]) */
  cycles?: number[];
  /** Starting cycle (e.g. 2021) if cycles array is not provided */
  startCycle?: number;
  /** Total number of cycles to advance */
  totalCycles?: number;
  entities: EntityCandidate[];
  heroInjector: HeroInjector;
  motifSampler: MotifSampler;
  ladderEngine: StateLadderEngine;
  factorEngine?: FactorEngine;
  eras?: EraConfig[];
  domain?: DomainConfig;
  factorContracts?: FactorContract[];
  annualWanderStdDev?: number;
  cycleUnit?: 'year' | 'week';
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
  private factorEngine: FactorEngine;
  private compiledFeatures = new Map<string, FeatureEvaluator>();
  public readonly cycles: number[];

  constructor(private config: UnrollConfig) {
    this.factorEngine = config.factorEngine ?? new FactorEngine();

    if (config.cycles && config.cycles.length > 0) {
      this.cycles = [...config.cycles];
    } else {
      const start = config.startCycle ?? 0;
      const count = config.totalCycles ?? 1;
      this.cycles = Array.from({ length: count }, (_, i) => start + i);
    }

    // Precompile feature queries on contract arrows (hoisted for performance)
    for (const contract of config.factorContracts ?? []) {
      for (const [arrowKey, arrow] of Object.entries(contract.arrows)) {
        const arrowName = arrow.name ?? arrowKey;
        if ('feature' in arrow && arrow.feature) {
          if (arrow.feature.from && arrow.feature.from !== 'self' && !config.domain) {
            throw new Error(
              `RetrospectiveUnroller: DomainConfig is required on UnrollConfig when non-self feature arrows exist (arrow '${arrowName}' on factor '${contract.id}' queries entity '${arrow.feature.from}')`
            );
          }
          if (!this.compiledFeatures.has(arrowName)) {
            this.compiledFeatures.set(arrowName, compileFeature(arrow.feature, contract.effect));
          }
        }
      }
    }
  }

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

    // Apply initial motif ladder progressions for non-heroes
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

    // 4. Enroll cohort into ladders according to ladder.cohortShare (Plan 02 §3.3)
    for (const ladder of ladderEngine.GetAllLadders()) {
      const eligible = Array.from(this.entityStates.values()).filter(
        (e) => !e.isHero && e.entity === ladder.entity && !e.ladderStates[ladder.ladderKey]
      );
      const targetCount = Math.round(eligible.length * ladder.cohortShare);
      const shuffled = rng.shuffle(eligible);
      for (let i = 0; i < targetCount; i++) {
        const ent = shuffled[i]!;
        const initialState = ladder.states[0]?.name;
        if (initialState) {
          ladderEngine.Enroll(ladder.ladderKey, ent.id, initialState, ent.birthCycle);
          ent.ladderStates[ladder.ladderKey] = initialState;
        }
      }
    }
  }

  /**
   * Runs the multi-cycle retrospective simulation across absolute cycles.
   */
  public Run(rng: RngStream): CycleSnapshot[] {
    const snapshots: CycleSnapshot[] = [];
    const { ladderEngine, factorContracts = [] } = this.config;

    for (const c of this.cycles) {
      // 1. Identify active eras for absolute cycle c
      const activeEras = (this.config.eras ?? []).filter((era) => era.cycles.includes(c));
      const activeEraKeys = new Set(activeEras.map((e) => e.eraKey));
      const eraFactorAdjustments = new Map<string, number>();
      for (const era of activeEras) {
        for (const adj of era.factorAdjustments) {
          const prev = eraFactorAdjustments.get(adj.factor) ?? 0;
          eraFactorAdjustments.set(adj.factor, prev + adj.deltaIntercept);
        }
      }

      // 2. Advance hero scripted ladder progressions
      for (const hero of this.config.heroInjector.GetAllHeroes()) {
        const state = this.entityStates.get(hero.id);
        if (!state || c < state.birthCycle) continue;

        const laddersInvolved = new Set(hero.ladderEntries.map((e) => e.ladderKey));
        for (const ladderKey of laddersInvolved) {
          const entering = hero.ladderEntries.find((e) => e.ladderKey === ladderKey && e.enterCycle === c);
          const exiting = hero.ladderEntries.find((e) => e.ladderKey === ladderKey && e.exitCycle === c);
          if (entering) {
            ladderEngine.ForceTransition(entering.ladderKey, hero.id, entering.state, c);
            state.ladderStates[entering.ladderKey] = entering.state;
          } else if (exiting) {
            ladderEngine.ExitLadder(exiting.ladderKey, hero.id, c);
            delete state.ladderStates[exiting.ladderKey];
          }
        }
      }

      // 3. Filter active entities for cycle c
      const activeEntities: UnrollEntityState[] = [];
      for (const entity of this.entityStates.values()) {
        if (c >= entity.birthCycle) {
          activeEntities.push(entity);
        }
      }

      // 4. Advance latent dials and non-hero ladders
      for (const entity of activeEntities) {
        const cyclesSinceBirth = c - entity.birthCycle;
        const assignments = this.motifAssignments.get(entity.id) ?? [];
        const entityRng = rng.substream(`entity:${entity.entity}`).substream(`${entity.id}:${c}:profile`);

        // Advance latent dials via FactorEngine profile or motif trajectory
        const profile: LatentProfile = { entityId: entity.id, dials: { ...entity.latentDials } };
        const advanced = this.factorEngine.AdvanceProfile(entityRng, profile, 1);
        entity.latentDials = advanced.dials;

        // Apply motif deterministic trajectory adjustments
        for (const a of assignments) {
          if (a.latentTrajectory) {
            const eraApplies = !a.eras || a.eras.length === 0 || a.eras.some((k) => activeEraKeys.has(k));
            if (eraApplies) {
              const cur = entity.latentDials[a.latentTrajectory.dial] ?? 0;
              entity.latentDials[a.latentTrajectory.dial] = cur + a.latentTrajectory.deltaPerCycle;
            }
          }
        }

        // Step non-hero ladders
        if (!entity.isHero) {
          for (const ladder of ladderEngine.GetAllLadders()) {
            const cycleUnit = this.config.cycleUnit ?? 'year';
            const ladderCyclesSinceBirth = cycleUnit === 'week' ? cyclesSinceBirth * 52 : cyclesSinceBirth;
            const stepAmount = cycleUnit === 'week' ? 52 : 1;
            const stepResult = ladderEngine.StepEntity(ladder.ladderKey, entity.id, {
              cycle: cycleUnit === 'week' ? c * 52 : c,
              cyclesSinceBirth: ladderCyclesSinceBirth,
              latentDials: entity.latentDials,
              stepAmount,
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
        } else {
          for (const ladder of ladderEngine.GetAllLadders()) {
            const st = ladderEngine.GetEntityState(ladder.ladderKey, entity.id);
            if (st) {
              const cycleUnit = this.config.cycleUnit ?? 'year';
              st.tenureInCurrentState = cycleUnit === 'week' ? (c - st.enteredCycle) * 52 : c - st.enteredCycle;
            }
          }
        }
      }

      // 5. Evaluate factor contracts with calibrateIntercept and era adjustments
      const outcomesCount: Record<string, number> = {};

      // Build relational context for child aggregations and multi-hop traversal in feature queries (R4-1)
      const relationalCtx: RelationalContext = {
        getEntity: (entityName: string, id: string) => {
          const s = this.entityStates.get(id);
          if (!s || s.entity !== entityName) return undefined;
          return { ID: s.id, id: s.id, __entityName: s.entity, ...s.fixedFields, ...s.latentDials, ...s.ladderStates };
        },
        getChildren: (parentEntity: string, parentId: string, childEntity: string, foreignKeyField: string) => {
          const results: EntityRecord[] = [];
          const parentNorm = parentId.toLowerCase();
          const childCfg = this.config.domain?.entities[childEntity];

          for (const s of this.entityStates.values()) {
            if (s.entity !== childEntity) continue;

            if (foreignKeyField) {
              const val = s.fixedFields[foreignKeyField];
              if (val && String(val).toLowerCase() === parentNorm) {
                results.push({ ID: s.id, id: s.id, __entityName: s.entity, ...s.fixedFields, ...s.latentDials, ...s.ladderStates });
              }
              continue;
            }

            if (childCfg) {
              for (const [fkKey, fk] of Object.entries(childCfg.foreignKeys)) {
                if (!parentEntity || fk.targetEntity === parentEntity) {
                  const fieldName = fk.fieldName ?? fkKey;
                  const val = s.fixedFields[fieldName];
                  if (val && String(val).toLowerCase() === parentNorm) {
                    results.push({ ID: s.id, id: s.id, __entityName: s.entity, ...s.fixedFields, ...s.latentDials, ...s.ladderStates });
                    break;
                  }
                }
              }
            }
          }
          return results;
        },
      };

      for (const contract of factorContracts) {
        let positiveCount = 0;

        // A. Compute linear scores for active entities matching contract.effect
        const entityScores: { entity: UnrollEntityState; score: number; overrideProb?: number }[] = [];
        const targetEntities = activeEntities.filter((e) => e.entity === contract.effect);
        if (targetEntities.length === 0) {
          throw new Error(
            `RetrospectiveUnroller: Factor contract '${contract.id}' specifies effect entity '${contract.effect}' which matches no active entity in simulation.`
          );
        }

        for (const entity of targetEntities) {
          const assignments = this.motifAssignments.get(entity.id) ?? [];

          // Check motif factor override (intercept or probability)
          let overrideProb: number | undefined;
          for (const a of assignments) {
            const eraApplies = !a.eras || a.eras.length === 0 || a.eras.some((k) => activeEraKeys.has(k));
            if (!eraApplies) continue;

            const fo = a.factorOverrides.find((o) => o.factor === contract.id);
            if (fo) {
              if (fo.probability !== undefined) overrideProb = fo.probability;
            }
          }

          if (overrideProb !== undefined) {
            entityScores.push({ entity, score: 0, overrideProb });
            continue;
          }

          // Evaluate linear logit score: arrows + ladder state effects
          let score = 0;
          for (const [arrowKey, arrow] of Object.entries(contract.arrows)) {
            const arrowName = arrow.name ?? arrowKey;
            let featureVal = 0;
            if ('dial' in arrow && arrow.dial) {
              featureVal = entity.latentDials[arrow.dial] ?? 0;
            } else if ('feature' in arrow && arrow.feature) {
              let evaluator = this.compiledFeatures.get(arrowName);
              if (!evaluator) {
                evaluator = compileFeature(arrow.feature, contract.effect);
                this.compiledFeatures.set(arrowName, evaluator);
              }
              featureVal = evaluator(
                { ID: entity.id, id: entity.id, __entityName: entity.entity, ...entity.fixedFields, ...entity.latentDials, ...entity.ladderStates },
                relationalCtx
              );
            }

            // Beta override per arrow (N3b: honor fo.arrow)
            let beta = arrow.beta;
            for (const a of assignments) {
              const eraApplies = !a.eras || a.eras.length === 0 || a.eras.some((k) => activeEraKeys.has(k));
              if (!eraApplies) continue;

              const fo = a.factorOverrides.find(
                (o) => o.factor === contract.id && (!o.arrow || o.arrow === arrowName)
              );
              if (fo && fo.beta !== undefined) {
                beta = fo.beta;
              }
            }

            score += beta * featureVal;
          }

          // Ladder effect adjustment
          for (const [ladderKey, currentState] of Object.entries(entity.ladderStates)) {
            const ladder = ladderEngine.GetLadder(ladderKey);
            const stateCfg = ladder?.states.find((s) => s.name === currentState);
            const effect = stateCfg?.effects.find((e) => e.factor === contract.id);
            if (effect) {
              score += effect.beta;
            }
          }

          entityScores.push({ entity, score });
        }

        // B. Calibrate base intercept so background active population matches contract.target
        let nonHeroScores = entityScores
          .filter((e) => !e.entity.isHero && e.overrideProb === undefined)
          .map((e) => e.score);
        if (nonHeroScores.length === 0) {
          nonHeroScores = entityScores.filter((e) => e.overrideProb === undefined).map((e) => e.score);
        }
        const baseIntercept = calibrateIntercept(nonHeroScores, contract.target);

        // Add era macroeconomic delta intercept
        const eraDelta = eraFactorAdjustments.get(contract.id) ?? 0;
        const finalIntercept = baseIntercept + eraDelta;

        // C. Evaluate realized outcomes
        for (const item of entityScores) {
          const { entity, score, overrideProb } = item;
          let realizedOutcome: boolean;

          // 1. Hero outcome pin conditioning (Invariant 2): condition the draw
          if (entity.isHero && entity.heroKey) {
            const pinned = this.config.heroInjector.GetOutcomePin(entity.heroKey, contract.id, c);
            if (pinned !== undefined) {
              const heroDrawRng = rng
                .substream(`entity:${entity.entity}`)
                .substream(`hero-outcome:${entity.id}:${c}:${contract.id}`);
              let attempt = 0;
              let drawn = false;
              let lastProb = 0;
              do {
                const drawSub = heroDrawRng.substream(`try:${attempt}`);
                lastProb = overrideProb !== undefined ? overrideProb : sigmoid(finalIntercept + score);
                drawn = drawSub.bernoulli(lastProb);
                attempt++;
              } while (drawn !== pinned && attempt < 100);

              if (drawn !== pinned) {
                throw new Error(
                  `Hero pin unsatisfiable under simulation ruleset: Hero '${entity.heroKey}' pinned outcome for factor '${contract.id}' to ${pinned} in cycle ${c}, but rejection sampling failed to draw ${pinned} after ${attempt} attempts (last probability: ${lastProb.toFixed(6)}).`
                );
              }
              realizedOutcome = drawn;
              this.recordOutcome(entity, c, contract.id, realizedOutcome);
              if (realizedOutcome) positiveCount++;
              continue;
            }
          }

          const entityDrawRng = rng
            .substream(`entity:${entity.entity}`)
            .substream(`${entity.id}:${c}:${contract.id}`);

          // 2. Motif probability override
          if (overrideProb !== undefined) {
            realizedOutcome = entityDrawRng.bernoulli(overrideProb);
          } else {
            // 3. Calibrated logistic draw
            const prob = sigmoid(finalIntercept + score);
            realizedOutcome = entityDrawRng.bernoulli(prob);
          }

          this.recordOutcome(entity, c, contract.id, realizedOutcome);
          if (realizedOutcome) positiveCount++;
        }

        outcomesCount[contract.id] = positiveCount;
      }

      snapshots.push({
        cycle: c,
        activePopulation: activeEntities.length,
        activeEras: activeEras.map((e) => e.eraKey),
        outcomesCount,
      });
    }

    return snapshots;
  }

  private recordOutcome(
    entity: UnrollEntityState,
    cycle: number,
    factorId: string,
    outcome: boolean
  ): void {
    let cycleOutcomes = entity.outcomesByCycle.get(cycle);
    if (!cycleOutcomes) {
      cycleOutcomes = {};
      entity.outcomesByCycle.set(cycle, cycleOutcomes);
    }
    cycleOutcomes[factorId] = outcome;
  }

  public GetEntityState(entityId: string): UnrollEntityState | undefined {
    return this.entityStates.get(entityId);
  }

  public GetMotifAssignments(entityId: string): MotifAssignment[] {
    return this.motifAssignments.get(entityId) ?? [];
  }

  public GetAllEntityStates(): UnrollEntityState[] {
    return Array.from(this.entityStates.values());
  }
}
