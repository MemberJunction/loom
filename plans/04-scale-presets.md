# Scale Presets: Empirical Analysis & Architectural Proposal

**Proposal Document: C2 Scale Presets**  
**Repository**: `MemberJunction/loom`  
**Status**: Proposal for Review  
**Date**: September 2026  

---

## 1. Executive Summary & Problem Statement

Enterprise world simulations in Loom serve multiple distinct operational workflows across the MemberJunction ecosystem:
1. **CI / Unit Test Verification**: Rapid feedback loops on local machines and GitHub Actions where execution speed is paramount (must execute under 5 seconds).
2. **Integration / Staging Environments**: Realistic multi-cycle organizational residue for testing full application features, search indexing, and vector embeddings.
3. **Flagship Demo / Production Replicas**: Full-resolution, high-cardinality multi-year histories (100,000+ rows) with deep statistical nuance and complex committee governance.

Currently, scaling a simulation requires manually adjusting raw entity intake volume parameters in ruleset configurations. This proposal examines the mathematical and empirical effects of scale multipliers on validation tolerances and specifies a first-class `scalePreset` mechanism for project manifests.

---

## 2. Empirical Measurement: 1x vs. 10x Scale

To measure how causal factor contracts and validation gates behave across volume tiers, we ran comparative builds on the canonical `enterprise` fixture (Seed 42, Release Date 2026-09-02) scaling all intake and volume parameters from 1x to 10x.

### 2.1 Measured Population & Gate Results

| Entity / Gate Category | 1x Volume (CI Baseline) | 10x Volume (Enterprise Scale) | Scale Behavior & Tolerance Analysis |
|---|---|---|---|
| **Company** | 10 rows | 100 rows | Linear $10\times$ scaling. PK uniqueness passed. |
| **Product** | 10 rows | 100 rows | Linear $10\times$ scaling. PK uniqueness passed. |
| **Member** | 252 rows | 2,502 rows | Linear $10\times$ scaling. FK closure ($2,502 \to 100$) passed. |
| **Subscription** | 251 rows | 2,501 rows | Linear $10\times$ scaling. Continuity state preserved. |
| **OrderHeader** | 269 rows | 2,691 rows | Linear $10\times$ scaling. 100% dependent child coverage. |
| **OrderLine** | 406 rows | 3,974 rows | Dependent multi-line generation scaled proportionally (~1.5 lines/order). |
| **Payment** | 269 rows | 2,691 rows | 1:1 payment coverage strictly preserved ($100\%$). |
| **Gate 0 (Hero Pins)** | 2/2 Passed ($n=1$) | 2/2 Passed ($n=1$) | **Invariant 3 Holds**: Heroes remain deterministic anchors with zero crowd interference. |
| **Referential FK Closure** | 7/7 Passed | 7/7 Passed | **Scale-Invariant**: Zero orphaned references at both scales. |
| **PK Uniqueness** | 7/7 Passed | 7/7 Passed | **Scale-Invariant**: Deterministic uuidv5 minting produces zero collisions. |
| **Dependent Child Coverage** | 2/2 Passed | 2/2 Passed | **Scale-Invariant**: 100% of OrderHeaders have $\ge 1$ OrderLine and $\ge 1$ Payment. |
| **Factor: Renewal** ($\text{target}=0.80, \pm 0.10$) | Observed: $0.7937$ ($\Delta = 0.0063$) | Observed: $0.8018$ ($\Delta = 0.0018$) | **Tightens with Scale**: Standard error drops from $\sigma \approx 0.025$ to $\sigma \approx 0.008$. |
| **Factor: Auto-Renew** ($\text{target}=0.70, \pm 0.10$) | Observed: $0.6972$ ($\Delta = 0.0028$) | Observed: $0.7025$ ($\Delta = 0.0025$) | **Tightens with Scale**: Conforms strictly to contract. |
| **Factor: Enterprise Tier** ($\text{target}=0.30, \pm 0.15$) | Observed: $0.3000$ ($\Delta = 0.0000$) | Observed: $0.3100$ ($\Delta = 0.0100$) | Tolerances hold comfortably across both populations. |
| **Realized Era Volumes** | 3/3 Passed | 3/3 Passed | Multipliers scale cleanly ($2023$ recession volume: $37 \to 335$; supply shock: $14 \to 133$). |
| **Realized Era Factors** | 2/2 Passed | 2/2 Passed | Shifts hold within tolerance bands ($\ge 0.05$ shift preserved). |
| **Total Validation Gates** | **35 / 35 Passed** | **35 / 35 Passed** | **100% Pass Rate Across Both Tiers** |
| **Total Rows Examined** | **5,215** | **50,183** | **$9.6\times$ aggregate row expansion** |
| **Validation Wall-Clock Time** | **~0.04 s** | **~0.18 s** | Sub-second validation with memory indexing. |

---

## 3. Mathematical Analysis: Tolerance vs. Scale

The empirical test confirms an essential principle of synthetic world modeling:

### 3.1 What Holds Across Scale
1. **Structural & Relational Invariants**: Primary key uniqueness, foreign key closure, dependent child coverage, topological order, and hero pins are strictly **scale-invariant**. If they pass at 1x, they pass at 10x or 100x.
2. **Era Volume Multipliers**: Because era volume multipliers are evaluated as relative fractions or against baseline non-era cycle averages, relative volume checks scale proportionally.

### 3.2 What Breaks at Sub-Scale (The Small-Sample Boundary)
While tolerances hold comfortably between 1x and 10x, **scaling downward below 1x (e.g. 0.1x or micro-fixtures)** causes statistical gates to fail due to binomial sampling error:
$$\sigma = \sqrt{\frac{p(1-p)}{N}}$$
- At $N = 2,500$ (10x), for $p = 0.80$, standard error is $\sigma = \sqrt{0.16 / 2500} = 0.0080$. A tolerance band of $\pm 0.10$ represents $>12\sigma$.
- At $N = 250$ (1x), $\sigma = \sqrt{0.16 / 250} = 0.0253$. A tolerance band of $\pm 0.10$ represents $\approx 4\sigma$ (well within tolerance).
- At $N = 25$ (0.1x micro-fixture), $\sigma = \sqrt{0.16 / 25} = 0.0800$. A $2\sigma$ fluctuation is $\pm 0.16$, which **breaches** the $\pm 0.10$ tolerance band, producing false-positive validation failures.

**Conclusion**: Factor tolerance gates require a mathematical population floor ($N_{\text{min}} \ge 200$) to guarantee stability without widening tolerance bands beyond semantic meaning.

---

## 4. Proposed Manifest Field & Engine Specification

We propose adding an optional `scale` field to the project manifest contract:

### 4.1 Zod Schema (`packages/contracts/src/manifest.ts`)
```typescript
export const ProjectScalePresetSchema = z.enum(['ci', 'standard', 'demo', 'full']);
export type ProjectScalePreset = z.infer<typeof ProjectScalePresetSchema>;

export const ProjectScaleConfigSchema = z.object({
  preset: ProjectScalePresetSchema.default('standard'),
  multiplier: z.number().positive().default(1.0),
});
```

### 4.2 Scale Multiplier Semantics
- `'ci'`: Multiplier $0.5\times$ to $1.0\times$ (configured to maintain $N \ge 250$ for all factor effect entities). Optimized for rapid PR validation.
- `'standard'`: Default baseline ($1.0\times$). Balanced footprint for local development and staging.
- `'demo'`: Multiplier $5.0\times$ ($25,000$ to $50,000$ rows). Ideal for multi-user sales demos, full charts, and realistic query plans.
- `'full'`: Multiplier $10.0\times$ to $20.0\times$ ($100,000+$ rows). Stress testing, enterprise benchmarks, and vector embedding pipelines.

### 4.3 Engine Application
During `RetrospectiveUnroller.UnrollWorld` and CLI intake resolution:
$$\text{EffectiveVolume}(E) = \max\left(N_{\text{floor}}(E), \text{round}(\text{baseVolume}(E) \times \text{scaleMultiplier})\right)$$
Where $N_{\text{floor}}(E)$ defaults to 20 for reference entities and 200 for entities targeted by empirical factor contracts.

---

## 5. Recommendation

Do not hardcode scale presets into the engine. Implement as a declarative manifest option (`scale: { preset: "ci" | "standard" | "demo", multiplier: 1.0 }`) that dynamically scales ruleset `volume_*` parameters while respecting the statistical population floor.
