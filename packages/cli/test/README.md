# CLI Test Suite

## Guidelines & Invariants

- **Shared Fixture Isolation**: Tests must never modify files under `projects/` directly; always copy fixture projects to temporary directories (e.g. via `fs.cp(fixturePath, tempDir, { recursive: true })`) before mutating configurations or files to prevent race conditions during parallel test execution.
