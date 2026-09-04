# 03: Nested Causality, Temporal Scoping, and Governance Semantics (C1 Proposal)

## 1. Executive Summary

This proposal addresses capability **C1** of the Loom simulation engine: expressing multi-level nested causality where events and decisions are temporally bounded by their parent containers, and where participant actors must hold qualifying roles with active temporal tenures covering the event date.

Specifically, we evaluate whether Loom's initial five generative patterns and existing relational validation rules can express:
$$\\text{Session} \\longrightarrow \\text{Item} \\longrightarrow \\text{Decision} \\longrightarrow \\text{Ballot}$$
where each ballot's actor must hold an active tenure covering the ballot date, from tenures that began cycles earlier and may end mid-sequence.

We evaluate both the **generation layer** and the **validation layer**, demonstrating that existing generation patterns require two minimal generic patterns (`nestedEvent` and `scopedDecision`) paired with a temporal role selector (`temporalRole`), while the validation layer already provides `date-window` for temporal containment and actor coverage, requiring only **one** new generic rule kind (`outcome-derived-from-ballots`).

---

## 2. Comprehensive Evaluation of Existing Architecture

### 2.1 Evaluation of Generative Patterns
Loom defines five generative patterns in `packages/engine/src/patterns/`:

1. **`annualParticipation`**:
   - *Mechanism*: Per cycle, an eligible entity pool faces a calibrated Bernoulli trial; positive outcomes spawn child records.
   - *Limitation*: Operates strictly on discrete cycle boundaries. Cannot enforce continuous sub-cycle timestamp bounding between parent containers and child events (e.g. a 2-hour session window on a specific date). Cannot filter actor eligibility dynamically against an interval $[\\text{Tenure.Start}, \\text{Tenure.End}]$ spanning arbitrary dates.

2. **`childOutcome`**:
   - *Mechanism*: Per parent record, evaluates a calibrated Bernoulli trial to assign a binary outcome (1:1 parent-to-outcome).
   - *Limitation*: Strictly 1:1. Cannot generate $M$ actor ballots per item across $N$ committee members. Cannot derive a parent decision outcome (e.g., `Passed` vs `Failed`) from an aggregated tally of discrete actor ballots.

3. **`recurringDecision`**:
   - *Mechanism*: Per cycle, an eligible cohort faces a calibrated binary decision with state consequences.
   - *Limitation*: Cohort selection is evaluated per discrete cycle index, not continuous temporal intervals. It does not model hierarchical containment ($A \\to B \\to C \\to D$) where child events inherit temporal bounds from parent events.

4. **`derivedTransaction`**:
   - *Mechanism*: Emits child transactional records with offset delay distributions (`TimingDistribution` / `drawOffsetDays`).
   - *Limitation*: Can offset child timestamps from a parent timestamp, but cannot enforce multi-level interval containment (e.g. Item date inside Session start/end). It does not validate actor tenure coverage or aggregate child records back into parent state.

5. **`staticAssignment`**:
   - *Mechanism*: Deterministic rule matching based on static context fields.
   - *Limitation*: Non-generative. No temporal reasoning, no sampling, no actor eligibility filtering.

### 2.2 Evaluation of Existing Relational Validation Rules (Loom #9)
Loom #9 introduced three generic relational rule kinds in `packages/contracts/src/domain.ts` evaluated by `Validator` in `packages/engine/src/validation/validator.ts`:

1. **`path-match`**:
   - *Mechanism*: Verifies that a child entity's foreign key reaches an ancestor matching a declared target.
   - *Limitation*: Structural/topological only; performs no temporal interval arithmetic.

2. **`date-window`**:
   - *Capabilities*:
     - Supports a source entity + date field.
     - Supports a window entity with start/end fields.
     - Supports **multiple windows per key** (grouped into interval lists per entity key).
     - Supports open-ended ends (null/undefined treated as active/ongoing).
     - Supports an optional link entity.
     - Evaluates whether "any window covers the date" ($W_{\\text{start}} \\le T \\le W_{\\text{end}}$), reporting population examined and out-of-window failure counts.
   - *Evaluation for C1*:
     - **`childInsideParentWindow` is already a `date-window` rule**:
       `sourceEntity: "Item"`, `dateField: "ItemDate"`, `windowEntity: "Session"`, `windowForeignKey: "SessionID"`, `windowStartField: "StartDate"`, `windowEndField: "EndDate"`, `requireWindow: true`.
     - **`actorRoleCoveringDate` is already a `date-window` rule**:
       `sourceEntity: "Ballot"`, `dateField: "BallotDate"`, `windowEntity: "Tenure"`, `windowForeignKey: "ActorID"`, `windowStartField: "StartDate"`, `windowEndField: "EndDate"`, `requireWindow: true`.
     - *Conclusion*: `Validator` requires **zero new code** for temporal window containment or actor tenure coverage. Existing `date-window` machinery handles both with $O(1)$ indexed map lookups.

3. **`text-contains-path`**:
   - *Mechanism*: Verifies narrative text embeds referenced entity identifiers or titles.
   - *Limitation*: Text verification only; unrelated to aggregation or voting tallies.

### 2.3 Conclusion
- **Generation**: Requires minimal generic patterns for nested event containment, tenure-based actor pooling, and ballot tally derivation.
- **Validation**: Reuses the existing `date-window` relational rule kind for both session containment and actor tenure coverage. Requires exactly **one** new generic validation rule kind: `outcome-derived-from-ballots` (derived from child tallies).

---

## 3. Minimal Generic Pattern Specifications

### 3.1 Tenure Generation, Lifecycles, and Continuity
Tenures are stateful records representing actor appointments to roles/bodies. Their full lifecycle operates across three mechanisms:
1. **Creation**:
   - Initial cohort tenures are generated at body creation or through an appointment mechanism using `annualParticipation` (e.g. annual cohort appointment to a body).
   - In `cycleUnit: year` or sub-cycle simulations, `StartDate` is established on appointment.
2. **Termination (Mid-Sequence Ending)**:
   - A tenure terminates when an actor resigns, is unseated, or term-limits.
   - Modeled via an actor lifecycle ladder (e.g. `tenure-status-ladder`: `Active` $\\to$ `Terminated`) with calibrated transition rates per cycle, or via a calibrated `recurringDecision` trial (retire/renew).
   - When termination occurs, `EndDate` is stamped with the termination timestamp, immediately excluding the actor from subsequent events.
3. **Cross-Cycle Persistence**:
   - Open-ended tenures (`EndDate` null or greater than current cycle) persist into `checkpoint.json` via `activeLifecycleStates` and continuity indices.
   - When `accumulate` runs for subsequent cycles (L10-4), the prior state contains all existing tenures, allowing active actors to be retrieved without re-generating prior history.

### 3.2 Pattern A: `nestedEvent` (Hierarchical Event Scoping)
- **Role**: Generates discrete child events whose occurrences are strictly bounded within a parent event's duration:
  $$T_{\\text{parent.start}} \\le T_{\\text{child.date}} \\le T_{\\text{parent.end}}$$
- **Reusing Timing Vocabulary**:
  - Reuses `TimingDistribution` and `drawOffsetDays` from `derivedTransaction.ts` (constant, uniform, lognormal offsets within parent window).
  - Sub-cycle dates are derived continuously: in `cycleUnit: year`, parent events select calendar dates within the year, and child events derive timestamps bounded by parent start/end.
- **Configuration**:
  - `parentEntity`: Name of parent entity (e.g. `Session`).
  - `childEntity`: Name of child entity (e.g. `Item`).
  - `timing`: `TimingDistribution` configuration.
  - `countDistribution`: Count or Poisson rate of child events per parent.

### 3.3 Pattern B: `temporalRole` (Tenure-Scoped Actor Selector)
- **Role**: A deterministic query selector and filtering utility over the active tenure pool:
  $$\\text{Tenure.StartDate} \\le T_{\\text{event}} \\le \\text{Tenure.EndDate}$$
- **Semantics**:
  - Given an event date $T$ and optional scope (e.g. `BodyID`), filters the active pool of actors whose tenure intervals cover $T$.
  - Used by `scopedDecision` to select eligible voters for each item.

### 3.4 Pattern C: `scopedDecision` (Aggregated Voting & Outcome Derivation)
- **Role**: Simulates discrete participant choices on an item, and derives the decision outcome strictly from ballot tallies.
- **Decision Rule Schema (Zod)**:
  - `rule`: `majority` ($\\sum \\text{Yes} > \\sum \\text{No}$), `supermajority-two-thirds` ($\\sum \\text{Yes} \\ge 2 \\sum \\text{No} \\land \\sum \\text{Yes} > 0$), or `unanimous` ($\\sum \\text{Yes} > 0 \\land \\sum \\text{No} = 0$).
  - `quorum`: Minimum ballots required for validity (defaults to 1 or fraction of active pool).
  - `tieRule`: Deterministic outcome on tie (`Failed` default or `Passed`).
  - `abstainHandling`: Whether abstentions count toward quorum or are ignored in threshold division (`ignore` default).
- **Categorical Ballot Draw & Factor Calibration**:
  - A ballot choice is categorical: `Yes`, `No`, `Abstain`.
  - Sampled deterministically via calibrated logistic model:
    $$P(\\text{Vote} = \\text{Yes}) = \\sigma(\\beta_0 + \\sum \\beta_i x_i)$$
    where $\\beta_0$ is calibrated against ruleset `targetApprovalRate`.
  - Participation / turnout trial determines `Abstain` vs cast vote.
  - The parent `Decision.Outcome` is computed strictly from the resulting ballot tallies according to the declared `rule`.

---

## 4. Generic Validation Gates & Populations

Validation gates leverage existing generic relational rules plus one new tally-derivation rule:

| Gate Name | Rule Kind | Invariant Checked | Population Formula |
|---|---|---|---|
| `item-inside-session` | `date-window` (Existing) | $T_{\\text{session.start}} \\le T_{\\text{item}} \\le T_{\\text{session.end}}$ | $N_{\\text{items}}$: Total count of nested child records |
| `ballot-actor-covered-by-tenure` | `date-window` (Existing) | $\\text{Tenure.Start} \\le T_{\\text{ballot}} \\le \\text{Tenure.End}$ | $N_{\\text{ballots}}$: Total count of ballots cast |
| `decision-outcome-derived-from-ballots` | `outcome-derived-from-ballots` (New) | $\\text{Decision.Outcome} \\equiv \\text{Tally}(\\text{Ballots})$ | $N_{\\text{decisions}}$: Total count of decisions evaluated |

---

## 5. Governance Fixture (`projects/governance-fixture/`)

### 5.1 Abstract Entities
- `Body`: The governing assembly.
- `Tenure`: Actor appointment intervals to a Body (`ActorID`, `BodyID`, `StartDate`, `EndDate`).
- `Session`: Scheduled convenings of a Body (`BodyID`, `StartDate`, `EndDate`).
- `Item`: Discrete business items introduced within a Session (`SessionID`, `ItemDate`, `Title`).
- `Decision`: The formal action taken on an Item (`ItemID`, `Outcome`, `DecisionDate`).
- `Ballot`: Individual votes cast on a Decision (`DecisionID`, `ActorID`, `Vote`, `BallotDate`).

### 5.2 Verification Criteria
1. **Byte-Identity**: Building `governance-fixture` twice with identical seed produces identical output (`diff -r` empty).
2. **Hero Non-Interference**: Injecting a hero into `governance-fixture` alters only the hero record; all non-hero rows remain byte-identical.
3. **Failing Mutation 1**: Injecting a ballot with `BallotDate` outside its actor's `Tenure` fails `date-window` gate.
4. **Failing Mutation 2**: Injecting a decision outcome that contradicts its ballot tally fails `outcome-derived-from-ballots` gate.
5. **Failing Mutation 3**: Injecting an item with `ItemDate` outside its session window fails `date-window` gate.
6. **Zero Domain Vocabulary**: `node scripts/check-domain-vocabulary.mjs` returns 0 hits across all engine, contract, and CLI code.
