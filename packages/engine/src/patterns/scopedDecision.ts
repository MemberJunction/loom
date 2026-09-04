import { createRng, type RngStream } from '../math/rng.js';
import { sigmoid, calibrateIntercept } from '../math/calibration.js';

export type DecisionRule = 'majority' | 'supermajority-two-thirds' | 'unanimous';

export interface ScopedDecisionOptions<TEvent, TActor, TBallot, TDecision> {
  seed: number;
  events: readonly TEvent[];
  eligibleActorsOf: (event: TEvent) => readonly TActor[];
  eventDateOf: (event: TEvent) => string;
  streamKey: (event: TEvent) => string;
  rule: DecisionRule;
  targetApprovalRate?: number;
  scoreOf?: (actor: TActor, event: TEvent) => number;
  createBallot: (
    rng: RngStream,
    event: TEvent,
    actor: TActor,
    vote: 'Yes' | 'No' | 'Abstain',
    ballotDate: string
  ) => TBallot;
  createDecision: (
    event: TEvent,
    outcome: 'Passed' | 'Failed',
    ballots: readonly TBallot[],
    decisionDate: string
  ) => TDecision;
}

export interface ScopedDecisionResult<TBallot, TDecision> {
  ballots: TBallot[];
  decisions: TDecision[];
}

/**
 * Pattern C: scopedDecision
 * Simulates discrete participant choices on an event/item,
 * and derives the outcome strictly from vote tallies.
 */
export function scopedDecision<TEvent, TActor, TBallot, TDecision>(
  opts: ScopedDecisionOptions<TEvent, TActor, TBallot, TDecision>
): ScopedDecisionResult<TBallot, TDecision> {
  const allBallots: TBallot[] = [];
  const allDecisions: TDecision[] = [];

  for (const event of opts.events) {
    const actors = opts.eligibleActorsOf(event);
    if (actors.length === 0) continue;

    const rng = createRng(opts.seed, opts.streamKey(event));
    const eventDate = opts.eventDateOf(event);

    const scores = opts.scoreOf ? actors.map((a) => opts.scoreOf!(a, event)) : actors.map(() => 0);
    const b0 = opts.targetApprovalRate !== undefined
      ? calibrateIntercept(scores, opts.targetApprovalRate)
      : 0.5;

    let yesVotes = 0;
    let noVotes = 0;
    const eventBallots: TBallot[] = [];

    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i]!;
      const score = scores[i] ?? 0;
      const prob = sigmoid(b0 + score);
      const vote: 'Yes' | 'No' = rng.bernoulli(prob) ? 'Yes' : 'No';
      if (vote === 'Yes') yesVotes++;
      else noVotes++;

      const voteRecord = opts.createBallot(rng, event, actor, vote, eventDate);
      eventBallots.push(voteRecord);
      allBallots.push(voteRecord);
    }

    let passed = false;
    if (opts.rule === 'majority') {
      passed = yesVotes > noVotes;
    } else if (opts.rule === 'supermajority-two-thirds') {
      passed = yesVotes >= 2 * noVotes && yesVotes > 0;
    } else if (opts.rule === 'unanimous') {
      passed = yesVotes > 0 && noVotes === 0;
    }

    const outcomeRecord = opts.createDecision(
      event,
      passed ? 'Passed' : 'Failed',
      eventBallots,
      eventDate
    );
    allDecisions.push(outcomeRecord);
  }

  return { ballots: allBallots, decisions: allDecisions };
}
