# Factor Contract Evidence Checkability: Architectural Options & Trade-Offs

**Options Paper: E1 Evidence Checkability**  
**Repository**: `MemberJunction/loom`  
**Status**: Exploration & Options Paper (No Code, No Decision)  
**Date**: September 2026  

---

## 1. Context & Problem Statement

In the Loom causal engine, every `FactorContract` requires an authored `evidence` block:

```typescript
export interface FactorEvidence {
  source: string;
  confidence: "high" | "medium" | "low" | "estimate";
  notes: string;
}
```

Currently, this block is **declarative and explanatory**: it serves as an immutable provenance record explaining to demo authors, auditors, and autonomous agents *why* a particular $\beta$ weight, outcome threshold, or base rate was chosen (e.g., citing industry benchmarks, real-world surveys, or client historical metrics).

However, during validation, the engine evaluates whether the generated data adheres to `{ target, tolerance }`, but treats `evidence` purely as passive metadata. 

This paper analyzes three distinct architectural options for making evidence **formally checkable**, evaluating the theoretical, computational, and authoring trade-offs of each. **Per Builder Brief directive, this paper proposes options only; it makes no binding decision and introduces no engine code.**

---

## 2. Option 1: Structural Evidence Schema (Authoring-Time Provenance Linting)

### 2.1 Concept
Option 1 formalizes the evidence contract with strict structural schema constraints evaluated at authoring and load time. An evidence declaration is invalid if it lacks verifiable citation metadata.

```typescript
export const StructuredEvidenceSchema = z.object({
  sourceType: z.enum(['peer_reviewed_study', 'industry_benchmark', 'client_historical_baseline', 'expert_estimate']),
  citation: z.string().min(10),
  observedPeriod: z.object({
    startYear: z.number().int(),
    endYear: z.number().int(),
  }),
  sampleSize: z.number().int().positive().optional(),
  confidence: z.enum(['high', 'medium', 'low', 'provisional']),
  auditHash: z.string().optional(), // SHA-256 hash of referenced source document
});
```

### 2.2 Mechanism
- Evaluated during `loom build` project loading and CI manifest linting (`DomainConfigSchema.parse`).
- Rejects colloquial, ambiguous, or placeholder evidence strings (e.g., `"notes": "just testing"`).

### 2.3 Trade-Off Analysis
- **Pros**:
  - Zero runtime simulation overhead ($O(1)$ JSON schema check).
  - Forces rigor and intellectual honesty during domain authoring; prevents synthetic hallucination of casual assumptions.
  - Highly auditable for enterprise compliance and regulatory validation.
- **Cons**:
  - Does not evaluate generated data; check is purely syntactic.
  - Increases friction for rapid prototyping of lightweight test fixtures.

---

## 3. Option 2: Evidence Derived from Causal Graph Topology (Identifiability & d-Separation)

### 3.1 Concept
Option 2 redefines "evidence" as a mathematical derivation directly from the causal Directed Acyclic Graph (DAG). Rather than citing an external text document, the evidence block specifies the **causal path condition** or **d-separation statement** that justifies the factor's identification.

$$\text{Evidence: } (X \perp\!\!\!\perp Y \mid Z)_{\mathcal{G}} \quad \text{or} \quad \beta_{XY} = \frac{\text{Cov}(X, Y \mid Z)}{\text{Var}(X \mid Z)}$$

```typescript
export interface GraphDerivationEvidence {
  identificationType: 'backdoor_adjustment' | 'frontdoor_adjustment' | 'instrumental_variable';
  conditioningSet: readonly string[]; // Variables Z blocking backdoor paths
  structuralEquations: readonly string[];
}
```

### 3.2 Mechanism
- The `CausalGraphResolver` executes graph analysis (e.g. Pearl's d-separation algorithms) on the declared entity and dial network.
- Verifies that the declared causal effect is non-parametrically identifiable given the declared latent variables ($\theta, \phi$) and observed covariates.
- Throws an authoring error if the factor contract claims an unconfounded causal effect that is structurally blocked or confounded by other graph edges.

### 3.3 Trade-Off Analysis
- **Pros**:
  - Mathematically grounded in causal inference theory; eliminates impossible causal claims.
  - 100% self-contained within the engine with zero external document dependencies.
  - Catches hidden confounders and cyclic dependencies before generating a single row.
- **Cons**:
  - High cognitive barrier for domain authors who may not be versed in graphical causal models.
  - Only verifies structural identifiability, not numerical magnitude accuracy.

---

## 4. Option 3: Post-Generation Empirical Population Gate (Subgroup Predicate Checking)

### 4.1 Concept
Option 3 treats evidence as an empirical **subgroup contract** verified directly over the generated dataset during `loom validate`. If the evidence claims that "tenured members renew at 90% while first-year members renew at 60%", the evidence block declares empirical predicates that the Validator evaluates.

```typescript
export interface EmpiricalEvidenceGate {
  evidencePredicates: readonly {
    subgroupWhere: Record<string, unknown>;
    expectedRate: number;
    tolerance: number;
  }[];
}
```

### 4.2 Mechanism
- Extends `Validator.checkFactorContracts` to evaluate not just the aggregate population mean, but the conditional distribution across authored strata.
- Invariant 7 is enforced: the gate reports the exact subpopulation visited.
- If the aggregate target passes but a declared subgroup deviates from historical evidence, the validation suite flags a discrepancy.

### 4.3 Trade-Off Analysis
- **Pros**:
  - Directly verifiable against generated data; provides empirical proof of realism.
  - Catches Simpson's Paradox and aggregation fallacies where overall numbers look right but sub-populations are inverted.
- **Cons**:
  - Increases validation execution time (additional stratification queries).
  - Can overlap with or duplicate `FactorContract.arrows` specifications.
  - May fail on small cohorts due to finite-sample variance.

---

## 5. Comparative Trade-Off Matrix

| Dimension | Option 1: Structural Schema | Option 2: Causal Graph Derivation | Option 3: Empirical Population Gate |
|---|---|---|---|
| **Verification Point** | Schema load time | Graph compilation time | Post-generation validation time |
| **Verification Target** | Metadata syntax & completeness | Graph DAG topology & confounding | Generated record distributions |
| **Computational Cost** | $\approx 0$ ms (instant) | $1$–$5$ ms (graph traversal) | $10$–$50$ ms (cohort filtering) |
| **Authoring Complexity** | Low | High | Medium |
| **Realism Guarantee** | Provenance guarantee | Identifiability guarantee | Distributional guarantee |
| **Failure Mode** | Missing/malformed fields | Confounded causal paths | Subgroup tolerance breaches |

---

## 6. Open Questions for Ecosystem Stakeholders

1. **Audience Alignment**: Does MemberJunction's primary audience (solution architects, demo engineers, enterprise evaluators) demand mathematical identifiability (Option 2) or provenance documentation (Option 1)?
2. **Layering Strategy**: Can Option 1 (authoring provenance) and Option 3 (empirical subgroup checking) be composed without overwhelming the factor contract schema?
3. **External Verification Tooling**: Should evidence validation be part of core `Validator` or delegated to an external audit linter?

---

*This document is an architectural exploration for the MemberJunction Loom project.*
