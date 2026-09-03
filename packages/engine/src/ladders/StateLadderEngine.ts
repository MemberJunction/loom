import type {
  StateLadderConfig,
  LadderEffect,
  LadderExitEffect,
} from '@memberjunction/loom-contracts';

export interface EntityLadderState {
  entityId: string;
  ladderKey: string;
  currentState: string;
  tenureInCurrentState: number;
  enteredCycle: number;
  history: Array<{
    state: string;
    enterCycle: number;
    exitCycle?: number;
  }>;
}

export interface LadderStepContext {
  cycle: number;
  cyclesSinceBirth: number;
  latentDials: Record<string, number>;
}

export interface LadderStepResult {
  transitioned: boolean;
  priorState?: string;
  newState?: string;
  effects: LadderEffect[];
  exitEffects: LadderExitEffect[];
}

/**
 * Executes discrete Markov state machine progressions across cycles.
 * Enforces Invariant 4: State ladder transition integrity and capacity constraints.
 */
export class StateLadderEngine {
  private ladders = new Map<string, StateLadderConfig>();
  private activeStates = new Map<string, Map<string, EntityLadderState>>(); // ladderKey -> (entityId -> state)

  constructor(configs: StateLadderConfig[] = []) {
    for (const config of configs) {
      this.RegisterLadder(config);
    }
  }

  public RegisterLadder(config: StateLadderConfig): void {
    this.ladders.set(config.ladderKey, config);
    if (!this.activeStates.has(config.ladderKey)) {
      this.activeStates.set(config.ladderKey, new Map());
    }
  }

  public GetLadder(ladderKey: string): StateLadderConfig | undefined {
    return this.ladders.get(ladderKey);
  }

  public GetAllLadders(): StateLadderConfig[] {
    return Array.from(this.ladders.values());
  }

  /**
   * Enrolls an entity into a ladder at an initial state.
   */
  public Enroll(
    ladderKey: string,
    entityId: string,
    initialStateName: string,
    cycle: number
  ): EntityLadderState {
    const ladder = this.ladders.get(ladderKey);
    if (!ladder) {
      throw new Error(`StateLadderEngine: unknown ladder '${ladderKey}'`);
    }

    const stateObj = ladder.states.find((s) => s.name === initialStateName);
    if (!stateObj) {
      throw new Error(`StateLadderEngine: state '${initialStateName}' not found in ladder '${ladderKey}'`);
    }

    const entityState: EntityLadderState = {
      entityId,
      ladderKey,
      currentState: initialStateName,
      tenureInCurrentState: 0,
      enteredCycle: cycle,
      history: [{ state: initialStateName, enterCycle: cycle }],
    };

    this.activeStates.get(ladderKey)!.set(entityId, entityState);
    return entityState;
  }

  public GetEntityState(ladderKey: string, entityId: string): EntityLadderState | undefined {
    return this.activeStates.get(ladderKey)?.get(entityId);
  }

  /**
   * Counts how many entities currently occupy a given ladder state.
   */
  public GetStateOccupancy(ladderKey: string, stateName: string): number {
    const map = this.activeStates.get(ladderKey);
    if (!map) return 0;
    let count = 0;
    for (const s of map.values()) {
      if (s.currentState === stateName) count++;
    }
    return count;
  }

  /**
   * Evaluates progression for an enrolled entity at a new cycle.
   */
  public StepEntity(
    ladderKey: string,
    entityId: string,
    ctx: LadderStepContext
  ): LadderStepResult {
    const ladder = this.ladders.get(ladderKey);
    if (!ladder) {
      return { transitioned: false, effects: [], exitEffects: [] };
    }

    const state = this.activeStates.get(ladderKey)?.get(entityId);
    if (!state) {
      return { transitioned: false, effects: [], exitEffects: [] };
    }

    state.tenureInCurrentState += 1;

    const currentIndex = ladder.states.findIndex((s) => s.name === state.currentState);
    if (currentIndex === -1) {
      return { transitioned: false, effects: [], exitEffects: [] };
    }

    const currentStateConfig = ladder.states[currentIndex]!;

    // Check if tenure condition met
    if (state.tenureInCurrentState < currentStateConfig.durationCycles) {
      // Stay in current state, continuous active effects apply
      return {
        transitioned: false,
        effects: [...currentStateConfig.effects],
        exitEffects: [],
      };
    }

    // Attempt transition to next state if one exists
    const nextIndex = currentIndex + 1;
    if (nextIndex >= ladder.states.length) {
      // Terminal state reached: exit ladder
      const lastEntry = state.history[state.history.length - 1];
      if (lastEntry) lastEntry.exitCycle = ctx.cycle;

      this.activeStates.get(ladderKey)!.delete(entityId);

      return {
        transitioned: true,
        priorState: state.currentState,
        newState: undefined,
        effects: [],
        exitEffects: [...currentStateConfig.exitEffects],
      };
    }

    const nextStateConfig = ladder.states[nextIndex]!;

    // Check prerequisites
    if (nextStateConfig.prerequisites) {
      const prereq = nextStateConfig.prerequisites;
      if (prereq.priorState && prereq.priorState !== state.currentState) {
        return { transitioned: false, effects: [...currentStateConfig.effects], exitEffects: [] };
      }
      if (prereq.minCyclesSinceBirth !== undefined && ctx.cyclesSinceBirth < prereq.minCyclesSinceBirth) {
        return { transitioned: false, effects: [...currentStateConfig.effects], exitEffects: [] };
      }
      if (prereq.dials) {
        for (const [dial, bounds] of Object.entries(prereq.dials)) {
          const val = ctx.latentDials[dial];
          if (val === undefined) return { transitioned: false, effects: [...currentStateConfig.effects], exitEffects: [] };
          if (bounds.min !== undefined && val < bounds.min) return { transitioned: false, effects: [...currentStateConfig.effects], exitEffects: [] };
          if (bounds.max !== undefined && val > bounds.max) return { transitioned: false, effects: [...currentStateConfig.effects], exitEffects: [] };
        }
      }
    }

    // Check capacity constraint
    if (nextStateConfig.capacity !== undefined) {
      const currentOccupancy = this.GetStateOccupancy(ladderKey, nextStateConfig.name);
      if (currentOccupancy >= nextStateConfig.capacity) {
        // Capacity full: entity remains in current state until a slot frees up
        return { transitioned: false, effects: [...currentStateConfig.effects], exitEffects: [] };
      }
    }

    // Transition succeeds
    const priorState = state.currentState;
    const lastHistory = state.history[state.history.length - 1];
    if (lastHistory) lastHistory.exitCycle = ctx.cycle;

    state.currentState = nextStateConfig.name;
    state.tenureInCurrentState = 0;
    state.enteredCycle = ctx.cycle;
    state.history.push({ state: nextStateConfig.name, enterCycle: ctx.cycle });

    return {
      transitioned: true,
      priorState,
      newState: nextStateConfig.name,
      effects: [...nextStateConfig.effects],
      exitEffects: [...currentStateConfig.exitEffects],
    };
  }
}
