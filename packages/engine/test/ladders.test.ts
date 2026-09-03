import { describe, it, expect } from 'vitest';
import { StateLadderEngine } from '../src/ladders/StateLadderEngine.js';
import type { StateLadderConfig } from '@memberjunction/loom-contracts';

describe('StateLadderEngine', () => {
  const ladderMock: StateLadderConfig = {
    ladderKey: 'gov-ladder',
    entity: 'Person',
    binding: { mode: 'field', field: 'CurrentRole' },
    cohortShare: 1,
    states: [
      {
        name: 'committee-member',
        durationCycles: 1,
        effects: [{ factor: 'engagement-score', beta: 0.5 }],
        exitEffects: [],
      },
      {
        name: 'vice-chair',
        durationCycles: 2,
        capacity: 2,
        prerequisites: { priorState: 'committee-member' },
        effects: [{ factor: 'engagement-score', beta: 1.0 }],
        exitEffects: [{ dial: 'influence', delta: 0.3 }],
      },
      {
        name: 'chair',
        durationCycles: 1,
        capacity: 1,
        prerequisites: { priorState: 'vice-chair' },
        effects: [{ factor: 'engagement-score', beta: 1.5 }],
        exitEffects: [{ dial: 'influence', delta: 0.5 }],
      },
    ],
  };

  it('enrolls entity and tracks state progression across cycles', () => {
    const engine = new StateLadderEngine([ladderMock]);
    const entityId = 'person-1';

    engine.Enroll('gov-ladder', entityId, 'committee-member', 0);
    expect(engine.GetEntityState('gov-ladder', entityId)?.currentState).toBe('committee-member');

    // Cycle 1: tenure reaches 1 -> should transition to vice-chair
    const res1 = engine.StepEntity('gov-ladder', entityId, {
      cycle: 1,
      cyclesSinceBirth: 3,
      latentDials: {},
    });

    expect(res1.transitioned).toBe(true);
    expect(res1.newState).toBe('vice-chair');
    expect(engine.GetEntityState('gov-ladder', entityId)?.currentState).toBe('vice-chair');

    // Cycle 2: tenure reaches 1 (duration is 2) -> stays in vice-chair
    const res2 = engine.StepEntity('gov-ladder', entityId, {
      cycle: 2,
      cyclesSinceBirth: 4,
      latentDials: {},
    });
    expect(res2.transitioned).toBe(false);

    // Cycle 3: tenure reaches 2 -> transitions to chair
    const res3 = engine.StepEntity('gov-ladder', entityId, {
      cycle: 3,
      cyclesSinceBirth: 5,
      latentDials: {},
    });
    expect(res3.transitioned).toBe(true);
    expect(res3.newState).toBe('chair');
    expect(res3.exitEffects).toHaveLength(1);
    expect(res3.exitEffects[0]?.dial).toBe('influence');
  });

  it('enforces capacity constraints', () => {
    const engine = new StateLadderEngine([ladderMock]);

    // Fill chair capacity (capacity: 1)
    engine.Enroll('gov-ladder', 'chair-holder', 'chair', 0);
    expect(engine.GetStateOccupancy('gov-ladder', 'chair')).toBe(1);

    // Enroll another entity in vice-chair who is ready to advance
    engine.Enroll('gov-ladder', 'contender', 'vice-chair', 0);
    const contenderState = engine.GetEntityState('gov-ladder', 'contender')!;
    contenderState.tenureInCurrentState = 2; // meets duration 2

    // Attempt advance to chair -> should be blocked by capacity
    const step = engine.StepEntity('gov-ladder', 'contender', {
      cycle: 1,
      cyclesSinceBirth: 5,
      latentDials: {},
    });

    expect(step.transitioned).toBe(false);
    expect(engine.GetEntityState('gov-ladder', 'contender')?.currentState).toBe('vice-chair');
  });

  it('supports scripted hero transitions via ForceTransition and ExitLadder', () => {
    const engine = new StateLadderEngine([ladderMock]);
    const heroId = 'hero-gwen';

    // Gwen enters as CommitteeMember at 2022
    engine.ForceTransition('gov-ladder', heroId, 'committee-member', 2022);
    expect(engine.GetEntityState('gov-ladder', heroId)?.currentState).toBe('committee-member');

    // Gwen advances to vice-chair at 2024
    engine.ForceTransition('gov-ladder', heroId, 'vice-chair', 2024);
    expect(engine.GetEntityState('gov-ladder', heroId)?.currentState).toBe('vice-chair');

    // Gwen advances to chair at 2026
    engine.ForceTransition('gov-ladder', heroId, 'chair', 2026);
    expect(engine.GetEntityState('gov-ladder', heroId)?.currentState).toBe('chair');

    // Gwen exits at 2028
    engine.ExitLadder('gov-ladder', heroId, 2028);
    expect(engine.GetEntityState('gov-ladder', heroId)).toBeUndefined();
  });
});
