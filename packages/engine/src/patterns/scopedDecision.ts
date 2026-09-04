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
  abstainRate?: number;
  quorum?: number;
  tieRule?: 'Passed' | 'Failed';
  abstainHandling?: 'ignore' | 'count-toward-quorum';
  categoricalWeights?: { Yes: number; No: number; Abstain?: number };
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
 * and derives the outcome strictly from vote tallies respecting quorum,
 * tie breaking rules, and abstain handling.
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
    let abstainVotes = 0;
    const eventBallots: TBallot[] = [];

    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i]!;
      let vote: 'Yes' | 'No' | 'Abstain';

      if (opts.categoricalWeights) {
        const weights = opts.categoricalWeights;
        const options: Array<{ value: 'Yes' | 'No' | 'Abstain'; weight: number }> = [
          { value: 'Yes', weight: weights.Yes },
          { value: 'No', weight: weights.No },
        ];
        if (weights.Abstain !== undefined && weights.Abstain > 0) {
          options.push({ value: 'Abstain', weight: weights.Abstain });
        }
        vote = rng.pickWeighted(options);
      } else {
        const abstainRate = opts.abstainRate ?? 0;
        const isAbstain = abstainRate > 0 && rng.bernoulli(abstainRate);
        if (isAbstain) {
          vote = 'Abstain';
        } else {
          const score = scores[i] ?? 0;
          const prob = sigmoid(b0 + score);
          vote = rng.bernoulli(prob) ? 'Yes' : 'No';
        }
      }

      if (vote === 'Yes') yesVotes++;
      else if (vote === 'No') noVotes++;
      else abstainVotes++;

      const voteRecord = opts.createBallot(rng, event, actor, vote, eventDate);
      eventBallots.push(voteRecord);
      allBallots.push(voteRecord);
    }

    const minQuorum = opts.quorum ?? 1;
    const quorumParticipants = opts.abstainHandling === 'count-toward-quorum'
      ? yesVotes + noVotes + abstainVotes
      : yesVotes + noVotes;

    let passed = false;
    if (quorumParticipants < minQuorum) {
      passed = false;
    } else if (opts.rule === 'supermajority-two-thirds') {
      passed = yesVotes >= 2 * noVotes && yesVotes > 0;
    } else if (opts.rule === 'unanimous') {
      passed = yesVotes > 0 && noVotes === 0;
    } else {
      // majority
      if (yesVotes > noVotes) {
        passed = true;
      } else if (yesVotes < noVotes) {
        passed = false;
      } else {
        passed = opts.tieRule === 'Passed';
      }
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
