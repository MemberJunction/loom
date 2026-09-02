# Loom: Architecture & Implementation Plan

**Deterministic, Causal Business World & Data Simulation Engine for MemberJunction**

Version 1.0 · September 2026  
Status: Approved Architectural Roadmap  
Target Repository: `MemberJunction/loom`  
Flagship Consumer: `MemberJunction/more-cheese`

---

## 1. Executive Summary & Core Philosophy

### 1.1 Why Loom Exists
Enterprise software demonstrations and integration test fixtures almost invariably fail the **realism test**. Conventional synthetic data generation relies on independent sampling across columns: pulling a name from a census list, an address from a postal file, an order total from a log-normal distribution, and a renewal flag from a coin flip. The resulting database satisfies simple schema constraints, but promptly collapses under analytical examination:
- Street names that do not exist in the listed municipality.
- High churn among customers who show daily platform logins.
- Support tickets and billing dispute threads opened simultaneously with payments.
- Total absence of operational residue: zero audit logs, empty saved views, no notifications, and no shared history.
- Brittle, stateless wipe-and-reseed cycles that break external references and produce massive 100MB+ SQL migration snapshots.

**Realism is not a property of plausible independent distributions. Realism is a property of causality, correlation, and continuous accumulation.**

### 1.2 The Core Premise: Causality First, Not Sampling
In Loom, no observable business record is minted in isolation:
1. **Underlying Dials**: Every participant in the world carries hidden, continuous latent variables (e.g., Engagement $\theta$, Affluence $\phi$, Risk Tolerance $\psi$, Market Headwinds $\omega$).
2. **Causal Factors**: Observable behaviors (attending a conference, renewing membership, disputing an invoice, submitting a support ticket) descend directly from these dials through explicitly declared **Factor Contracts**.
3. **Emergent Correlation**: Slice the resulting dataset across any dimension—financial, operational, or governance—and authentic correlations emerge naturally because they are downstream consequences of shared causes, not painted surface decorations.

### 1.3 The Core Shift: First-Class Accumulation
Real organizations do not drop their database and re-seed every quarter; they accumulate operational history over years. 
- Loom treats accumulation as a first-class engine primitive:
  $$\text{Loom: } (\text{domainConfig}, \text{seed}, \text{releaseDate}, \text{ruleset}, \text{priorState}) \longrightarrow \text{deltaRecords}$$
- Each simulation cycle ingests the committed prior state (`metadata/` JSON tree), respects continuity boundaries (active committee terms, open billing tickets, pending renewal grace periods), and emits **only new records**.
- Every delta is naturally a pure, additive Skyway migration (`spCreate`), eliminating destructive wipe scripts and massive migration captures.

---

## 2. Re-architecting Loom: From Procedural Script to Metadata Engine

The legacy generation approach in More Cheese (`datagen/`) proved the statistical principles of causality, factor contracts, and deterministic seeds. However, it suffered from structural limitations:
- Procedural generation scripts tightly coupled to association-specific entities.
- Fragile stringly-typed table maps and manual schema conversions.
- Stateless execution that forced brittle 122,000-row SQL snapshot captures.

**In Loom, we gut and rebuild the engine core to be 100% metadata-driven, fully configuration-based, and vastly more flexible:**

```mermaid
flowchart TD
    subgraph Inputs ["1. Declarative Inputs"]
        NC["Narrative Bible & Eras<br/>(Markdown / JSON feeds)"]
        DC["Domain Manifest & Schemas<br/>(Zod Domain Config)"]
        RS["Causal Factor Ruleset<br/>(Catalog, Params, Effects, Mixes)"]
        PS["Prior Committed State<br/>(metadata/** JSON Tree)"]
    end

    subgraph LoomCore ["2. Loom Engine Core (@memberjunction/loom-engine)"]
        CR["Causal Graph & Topo Resolver"]
        FR["Factor Engine (Latent Dials θ, φ)"]
        IS["Deterministic Identity (uuidv5)"]
        AR["Accumulation & Delta Resolver"]
        VR["Bidirectional Validator (300+ Gates)"]
    end

    subgraph Emitters ["3. Multi-Target Emission"]
        MS["Open App Metadata Tree<br/>(/metadata/** JSON)"]
        SM["Additive Skyway Migrations<br/>(V*__<Cycle>_Delta.sql)"]
        ARF["In-App Operational Residue<br/>(Dashboards, Views, Conversations)"]
    end

    subgraph VisualVerification ["4. Autonomous Verification Loop"]
        SKILL["Simulation Agent Skill<br/>(Weekly Orchestration)"]
        PW["Playwright Visual Inspector<br/>(Headless UI & Dashboard Verification)"]
    end

    Inputs --> LoomCore
    LoomCore --> Emitters
    Emitters --> VisualVerification
```

---

## 3. Monorepo Structure & Package Boundaries

Loom is organized as a pnpm monorepo governed by Turborepo:

```
loom/
├── packages/
│   ├── contracts/            # @memberjunction/loom-contracts
│   │   ├── src/
│   │   │   ├── domain.ts     # Domain manifest & entity configuration schemas
│   │   │   ├── factors.ts    # Factor contract types { effect, feature, evidence }
│   │   │   ├── ruleset.ts    # Ruleset module schemas (catalog, params, effects, mixes)
│   │   │   ├── state.ts      # Prior state, continuity state, and delta schemas
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── engine/               # @memberjunction/loom-engine
│   │   ├── src/
│   │   │   ├── graph/        # Causal dependency graph & topological sorter
│   │   │   ├── factors/      # Latent dial generator and factor evaluator
│   │   │   ├── identity/     # Deterministic uuidv5 namespace management
│   │   │   ├── accumulation/ # Prior state diffing and delta calculation
│   │   │   ├── validation/   # Bidirectional factor and referential gate engine
│   │   │   ├── emitters/     # Metadata JSON and Skyway SQL emitters
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── cli/                  # @memberjunction/loom-cli
│   │   ├── src/
│   │   │   ├── commands/     # build, accumulate, validate, inspect, emit
│   │   │   ├── bin/loom.ts   # Executable CLI entrypoint
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── agent-skill/          # @memberjunction/loom-agent-skill
│       ├── src/
│       │   ├── workflows/    # Weekly simulation cycle orchestration
│       │   ├── playwright/   # Browser visual verification scripts
│       │   ├── quality/      # LLM-bound narrative and data consistency checks
│       │   └── index.ts
│       └── package.json
│
├── projects/
│   └── fixture/              # Lightweight CI testbed project (~120 lines, verified every build)
│
├── docs/                     # Architecture specs, factor contract guide, CLI manual
├── plans/                    # Active implementation briefs and design roadmap
├── .github/workflows/        # CI: suite execution (335 gates + fixture build)
├── package.json              # Monorepo root
├── turbo.json                # Turborepo task pipeline
└── tsconfig.json             # Root strict TypeScript configuration
```

---

## 4. Key Subsystems & Design Specifications

### 4.1 `@memberjunction/loom-contracts`
Defines the strict type contracts and Zod runtime schemas for all Loom inputs and outputs:
- **`DomainConfig`**: Declares entities, primary business keys, foreign key edges, target schemas, and lifecycle states.
- **`FactorContract`**: Formally specifies causal relations:
  ```typescript
  export interface FactorContract<TFeature = unknown> {
    effect: string;
    feature: TFeature;
    evidence: {
      source: string;
      confidence: "high" | "medium" | "low" | "estimate";
      notes: string;
    };
    target: number;
    tolerance: number;
  }
  ```
- **`ContinuityState`**: Captures active committee terms, open dispute tickets, pending membership renewals, and active customer payment tokens required to bridge simulation cycles.

### 4.2 `@memberjunction/loom-engine`
The execution engine:
1. **Graph Resolution**: Evaluates entity and factor dependencies into a strict Directed Acyclic Graph (DAG):
   $$\text{Macro World} \longrightarrow \text{Parties (Orgs/People)} \longrightarrow \text{Dials} \longrightarrow \text{Committees/Roles} \longrightarrow \text{Events/Orders} \longrightarrow \text{Accounting JEs}$$
2. **Latent Dials**: Generates personal anchors and persistent random walks for $\theta$ (engagement) and $\phi$ (affluence).
3. **Accumulator**: Evaluates `currentWorld - priorState = deltaRecords`. Validates that existing IDs are never reassigned and that existing immutable records (confirmed orders, executed legal contracts) are never modified.
4. **Validator**: Derives verification gates from declarations. Verifies:
   - Referential closure (zero dangling UUIDs).
   - CHECK constraint compliance across all target schemas.
   - Tolerance bands for factor contracts.

### 4.3 Direct BizApps Suite Integration
Loom natively targets the solid BizApps schemas in the MemberJunction ecosystem:
- **`bizapps-common` (`__mj_BizAppsCommon`)**: 
  Generates `Person`, `Organization`, `Address`, `ContactMethod`, `Relationship`, and unified chronological `Activity` records.
- **`bizapps-orders` (`__mj_BizAppsOrders`)**: 
  Generates commercial transactions directly into real order tables: `Product`, `PriceBook`, `OrderHeader`, `OrderLine`, `CustomerPaymentMethod`, `Payment`, and `Subscription`.
- **`bizapps-accounting` (`__mj_BizAppsAccounting`)**: 
  Emits balanced subsidiary ledger journal entries per order line (`OrderLine.JournalEntryID`), stages ratable revenue recognition entries (`Dr Deferred Revenue / Cr Sales Revenue`), and resolves GL accounts by role.
- **`bizapps-tasks` & `bizapps-issues`**: 
  Spawns committee action items, renewal outreach tasks, and customer support tickets with authentic lifecycle state transitions.
- **`bizapps-secure-messaging`**: 
  Constructs customer portal support threads and message exchanges derived directly from issue state transitions.

### 4.4 In-App Artifacts & Metadata Workflow
Loom codifies the clean separation between causal data generation and in-app operational residue:
- **No Synthetic JSON Guesswork**: In-app artifacts (Explorer dashboards, saved query views, agent conversation histories, pinned lists) are created natively in the UI by demo authors and personas.
- **`mj sync pull` Extraction**: Running `mj sync pull` captures those live database records into `/metadata/**`.
- **Versioned Packaging**: The committed metadata files are packaged into standard Open App migrations (`V*__Metadata_Sync.sql`) alongside Loom's data migrations.

---

## 5. The Weekly Simulation Agent Skill with Playwright

Loom introduces an autonomous **Agent Skill** to automate the recurring weekly accumulation cycle:

```mermaid
sequenceDiagram
    autonumber
    actor Scheduler as Scheduler / Workflow
    participant Skill as Simulation Agent Skill
    participant LLM as Story Evolution LLM
    participant Loom as Loom Engine CLI
    participant Host as Local MJ Host (MJAPI + Explorer)
    participant PW as Playwright Inspector
    participant Git as Git Repository

    Scheduler->>Skill: Trigger Weekly Run
    Skill->>LLM: Advance Narrative Bible (Current Events & Story Arcs)
    LLM-->>Skill: Updated Narrative & Factor Rules
    Skill->>Loom: loom accumulate --weeks=1
    Loom-->>Skill: Generated Delta Records & Metadata Sync
    Skill->>Loom: loom validate
    Loom-->>Skill: 300+ Automated Gates Passed
    Skill->>Host: Boot Local Host Stack (Port 4103 / 4303)
    Skill->>PW: Run Visual Inspection Suite
    PW->>Host: Navigate Dashboards & Persona Views
    PW-->>Skill: Visual Invariants Verified (No Render/GraphQL Errors)
    Skill->>Git: Commit Accumulated Delta & Push PR
```

### Key Playwright Verification Invariants:
1. **Dashboard Health**: Verifies that dashboard cards, KPI gauges, and chart components load and render with non-zero, valid values.
2. **Persona Authenticity**: Logs in as key personas (e.g. CEO, VP Membership) to ensure user-scoped views, notifications, and conversation histories are intact.
3. **Zero Console & GraphQL Errors**: Listens for network error responses (`errors` field in GraphQL responses) or uncaught console exceptions during navigation.

---

## 6. Implementation Roadmap & Sequencing

### Phase 1: Monorepo & Contracts Foundation
- [x] Initialize monorepo workspace configuration (`pnpm-workspace.yaml`, `package.json`, `turbo.json`, `tsconfig.json`).
- [x] Implement `@memberjunction/loom-contracts` with complete Zod schemas for domain configurations, factors, and rulesets.
- [x] Implement `projects/fixture` as the baseline CI project.
- [x] Setup GitHub Actions workflow running monorepo build, lint, and typecheck.

### Phase 2: Core Engine Rebuild (`@memberjunction/loom-engine`)
- [x] Implement `CausalGraphResolver` (topological dependency sorter).
- [x] Implement `FactorEngine` (latent dial generation via Cholesky decomposition and factor contract evaluation).
- [x] Implement `IdentityService` (deterministic `uuidv5` namespace registration).
- [x] Implement `Validator` (referential closure and empirical factor tolerance evaluation).
- [x] Implement multi-target emitters (`metadata/` JSON tree and Skyway SQL).

### Phase 3: The `loom` CLI (`@memberjunction/loom-cli`)
- [x] Implement `loom build` (full baseline generation).
- [x] Implement `loom validate` (comprehensive gate execution with Invariant 7).
- [ ] Implement `loom inspect` (interactive graph and factor inspection).
- [x] Wire CLI into monorepo and verify end-to-end execution against `projects/fixture`.

### Phase 4: Accumulation Engine & Delta Resolver
- [x] Implement stateful prior-state reader and continuity boundary tracker (`Accumulator`).
- [x] Implement `loom accumulate` CLI command.
- [x] Implement delta emitter producing versioned Skyway `spCreate` migrations.
- [x] Verify multi-cycle accumulation on `projects/fixture`.

### Phase 5: More Cheese Migration to Loom
- [ ] Define More Cheese domain manifest and factor ruleset in Loom.
- [ ] Retire `morecheese_orders` stand-in tables; wire direct generation into real `bizapps-orders` and `bizapps-accounting` schemas.
- [ ] Emit initial 5-year baseline history and one-time date alignment script.
- [ ] Verify all 335 More Cheese validation gates pass against the new Loom engine.

### Phase 6: Weekly Simulation Agent Skill & Playwright Automation
- [ ] Implement the Weekly Simulation Agent Skill package.
- [ ] Implement Playwright visual inspection scripts for MJExplorer dashboards and persona views.
- [ ] Configure recurring GitHub Actions workflow for weekly automated simulation advances.

---

*Loom is developed as core MemberJunction infrastructure under the Business Source License 1.1 (BUSL-1.1).*
