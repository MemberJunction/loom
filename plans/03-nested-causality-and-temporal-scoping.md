# 03: Nested Causality, Temporal Scoping, and Governance Semantics (C1 Proposal)

## 1. Executive Summary

This proposal addresses capability **C1** of the Loom simulation engine: expressing multi-level nested causality where events and decisions are temporally bounded by their parent containers, and where participant actors must hold qualifying roles with active temporal tenures covering the event date.

Specifically, we evaluate whether Loom's initial five generative patterns can express:
$$\text{Session} \longrightarrow \text{Item} \longrightarrow \text{Decision} \longrightarrow \text{Ballot}$$
where each ballot's actor must hold an active tenure covering the ballot date, from tenures that began cycles earlier and may end mid-sequence.

We demonstrate that the existing patterns cannot express these semantics without ad-hoc fabrication, and we specify the minimal set of generic, schema-agnostic patterns and validation gates required to deliver C1.

---

## 2. Evaluation of Existing Patterns

Loom currently defines five generative patterns in `packages/engine/src/patterns/`:

### 2.1 `annualParticipation`
- **Definition**: Each year/cycle, an eligible entity pool faces a calibrated Bernoulli trial; positive outcomes spawn child records.
- **Evaluation**: Operates strictly on annual cycles. Cannot enforce continuous sub-cycle timestamp bounding between parent containers and child events (e.g., a 2-hour session window on a specific date). Cannot filter actor eligibility dynamically against an interval $[\text{Tenure.Start}, \text{Tenure.End}]$ spanning arbitrary dates.

### 2.2 `childOutcome`
- **Definition**: Per parent record, evaluates a calibrated Bernoulli trial to assign a binary outcome (1:1 parent-to-outcome).
- **Evaluation**: Strictly 1:1. Cannot generate $M$ actor ballots per item across $N$ committee members. Cannot derive a parent decision outcome (e.g., `Passed` vs `Failed`) from an aggregated tally of discrete actor ballots.

### 2.3 `recurringDecision`
- **Definition**: Per cycle, an eligible cohort faces a calibrated binary decision with state consequences.
- **Evaluation**: Cohort selection is evaluated per discrete cycle index, not against continuous temporal intervals. It does not model hierarchical containment ($A \to B \to C \to D$) where child events inherit temporal bounds from parent events.

### 2.4 `derivedTransaction`
- **Definition**: Emits child transactional records with offset delay distributions (constant, uniform, lognormal).
- **Evaluation**: Can offset child timestamps from a parent timestamp, but cannot enforce multi-level interval containment (e.g. Item date inside Session start/end). It does not validate actor tenure coverage or aggregate child records back into parent state.

### 2.5 `staticAssignment`
- **Definition**: Pure deterministic rule matching based on static context fields.
- **Evaluation**: Completely non-generative. No temporal reasoning, no sampling, no actor eligibility filtering.

### 2.6 Conclusion
**The existing five patterns cannot express the required nested causality and temporal scoping.**
Any attempt to simulate `session > item > decision > ballot` with active actor tenures using the existing patterns requires manual scripting or external post-processing, violating Loom's core mandate of schema-agnostic, causal simulation.

---

## 3. Minimal Generic Pattern Specifications

To express nested causality and temporal scoping in a fully schema-agnostic manner, Loom requires three minimal generic patterns:

### Pattern A: `nestedEvent` (Hierarchical Event Scoping)
- **Role**: Generates discrete child events whose temporal occurrences are strictly bounded within a parent event's duration:
  $$T_{\text{parent.start}} \le T_{\text{child.date}} \le T_{\text{parent.end}}$$
- **Configuration**:
  - `parentEntity`: Name of the parent container entity (e.g., `Session`).
  - `childEntity`: Name of the nested event entity (e.g., `Item`).
  - `timing`: Distribution of child events within the parent window (ordered sequence, uniform offset, or fractional interval).
  - `countDistribution`: Number of child items per parent.

### Pattern B: `temporalRole` (Tenure-Scoped Actor Eligibility)
- **Role**: Manages actor pools where eligibility at timestamp $T$ requires an active tenure record:
  $$\text{Tenure.StartDate} \le T \le \text{Tenure.EndDate}$$
- **Semantics**:
  - Tenures are stateful records that begin in cycle $C_{\text{start}}$ and terminate in cycle $C_{\text{end}}$ (or remain open-ended).
  - An actor may only be sampled for an event or ballot if their tenure covers the exact event date.
  - Tenures may terminate mid-sequence, immediately disqualifying the actor from subsequent events in that cycle.

### Pattern C: `scopedDecision` (Aggregated Voting & Outcome Derivation)
- **Role**: Simulates discrete participant choices (ballots) on an item, and derives the decision outcome strictly from ballot tallies:
  - For an item at timestamp $T$, the active eligible actors from `temporalRole` cast ballots (`Yes`, `No`, `Abstain`) sampled via calibrated factor evaluation.
  - The parent `Decision` outcome (e.g. `Adopted`, `Rejected`) is computed deterministically from the ballot sum according to declared rules (e.g., simple majority $\sum \text{Yes} > \sum \text{No}$).

---

## 4. Generic Validation Gates & Populations

Every rule introduced for C1 must be validated by generic Validator gates with explicitly reported population counts:

| Gate Name | Invariant Checked | Population Formula |
|---|---|---|
| `childInsideParentWindow` | $T_{\text{parent.start}} \le T_{\text{child}} \le T_{\text{parent.end}}$ | $N_{\text{children}}$: Total count of nested child records |
| `actorRoleCoveringDate` | $\text{Tenure.Start} \le T_{\text{ballot}} \le \text{Tenure.End}$ | $N_{\text{ballots}}$: Total count of ballots cast |
| `outcomeDerivedFromBallots` | $\text{Decision.Outcome} \equiv \text{Tally}(\text{Ballots})$ | $N_{\text{decisions}}$: Total count of decisions evaluated |

---

## 5. Governance Fixture (`projects/governance-fixture/`)

To verify the implementation without coupling to any business domain (such as cheese or association committees), Loom will provide an abstract fixture `projects/governance-fixture/`:

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
3. **Failing Mutation 1**: Injecting a ballot with `BallotDate` outside its actor's `Tenure` fails `actorRoleCoveringDate`.
4. **Failing Mutation 2**: Injecting a decision outcome that contradicts its ballot tally fails `outcomeDerivedFromBallots`.
5. **Failing Mutation 3**: Injecting an item with `ItemDate` outside its session window fails `childInsideParentWindow`.
6. **Zero Domain Vocabulary**: `node scripts/check-domain-vocabulary.mjs` returns 0 hits across all new engine and contract code.

---

## 6. Implementation Plan & Sign-Off

1. **Commit 1**: This proposal committed to `plans/03-nested-causality-and-temporal-scoping.md` on branch `an-dev-10`.
2. **Commit 2**: Generic contracts and Zod schemas added to `@memberjunction/loom-contracts`.
3. **Commit 3**: Engine patterns and Validator gates added to `@memberjunction/loom-engine`.
4. **Commit 4**: `projects/governance-fixture/` created with byte-identity and mutation tests.
