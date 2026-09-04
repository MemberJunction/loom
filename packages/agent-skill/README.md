# @memberjunction/loom-agent-skill

Agent skill package providing autonomous workflow orchestration for Loom simulations.

## Workflows

### `weeklyCycle`
The primary production workflow executing the complete four-stage lifecycle:
1. **Accumulate (`accumulate`)**: Advances simulation state by the configured cadence, appending delta records and generating deterministic checkpoint continuity.
2. **Validate (`validate`)**: Runs the full suite of referential closure, format, and relational integrity validation gates over the generated dataset.
3. **Push (`push`)**: Executes configurable metadata push (`mj sync push --dir <generatedDir>`) to synchronize dataset state to the target MemberJunction API environment.
4. **Visual Inspection (`playwright`)**: Launches Playwright browser automation to visually verify key application routes in MemberJunction Explorer.

### Strict Pipeline Invariants
- **Gate 1 Fail-Stop**: If `validate` fails any validation gate (`!validation.passed`), the pipeline immediately terminates and exits. Neither `push` nor `playwright` are executed.
- **Push Fail-Stop**: If `push` fails (network error, schema mismatch, unauthorized), the pipeline aborts immediately without proceeding to visual inspection.

## Test Execution Matrix (Unit Test Mocks vs Live Execution)

To ensure rapid, hermetic, and deterministic CI execution without external network or browser dependencies, unit tests configure specific boundaries:

| Subsystem | Live Execution | Unit Test / CI Execution | Rationale |
| :--- | :--- | :--- | :--- |
| **`accumulate`** | **LIVE** | **LIVE** | Executes actual `executeAccumulate` CLI/engine logic, computing diffs and persisting checkpoint files to disk. |
| **`validate`** | **LIVE** | **LIVE** | Executes full `executeValidate` engine logic against real serialized files, examining all referential, factor, and relational gates. |
| **`push`** | **LIVE** (`mj sync push`) | **STUBBED** (`executePush` callback) | Avoids requiring a running MJAPI GraphQL backend during test runs; records command lines and verifies strict invocation order. |
| **`playwright`** | **LIVE** (Chromium browser launch) | **MOCKED** (`vi.mock('playwright')`) | Avoids requiring local Chromium installation and display server during automated test runs; verifies route navigation and error logging. |
