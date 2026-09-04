import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { weeklyCycle, runWeeklySimulationCycle } from "../src/workflows/weeklyCycle.js";
import { executeBuild } from "@memberjunction/loom-cli";
import type { DomainConfig } from "@memberjunction/loom-contracts";

// Mock playwright for visual inspection step in unit tests
vi.mock("playwright", () => {
  return {
    chromium: {
      launch: vi.fn().mockImplementation(async () => {
        return {
          newPage: vi.fn().mockImplementation(async () => {
            return {
              on: vi.fn(),
              goto: vi.fn().mockResolvedValue(undefined),
              waitForLoadState: vi.fn().mockResolvedValue(undefined),
              $: vi.fn().mockResolvedValue(null),
            };
          }),
          close: vi.fn().mockResolvedValue(undefined),
        };
      }),
    },
  };
});

describe("L10-5 Agent Skill weeklyCycle Workflow", () => {
  const govFixturePath = path.resolve(__dirname, "../../../projects/governance-fixture");
  const tempDir = path.join(os.tmpdir(), "loom-skill-gov-" + Date.now());
  const baselineDir = path.join(tempDir, "baseline");
  const generatedDir = path.join(tempDir, "generated");

  beforeAll(async () => {
    await fs.mkdir(tempDir, { recursive: true });
    await executeBuild({
      project: govFixturePath,
      seed: "42",
      output: baselineDir,
    });
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("drives weeklyCycle over governance-fixture asserting accumulate -> validate -> push -> playwright order", async () => {
    const recordedSteps: string[] = [];
    const recordedCommands: string[] = [];

    const result = await weeklyCycle({
      projectDir: govFixturePath,
      priorStateDir: baselineDir,
      generatedDir,
      cycles: 1,
      seed: 42,
      enableVisualInspection: true,
      explorerUrl: "http://localhost:4200",
      routesToInspect: ["/governance"],
      recordStep: (step, cmd) => {
        recordedSteps.push(step);
        if (cmd) recordedCommands.push(cmd);
      },
      executePush: async (cmd) => {
        // Stubbed push command: record execution
        recordedCommands.push("EXECUTED: " + cmd);
      },
    });

    // Acceptance: assert strict pipeline order: accumulate -> validate -> push -> playwright
    expect(result.executionOrder).toEqual(["accumulate", "validate", "push", "playwright"]);
    expect(recordedSteps).toEqual(["accumulate", "validate", "push", "playwright"]);

    // Acceptance: assert push command line
    expect(result.pushCommandLine).toBe("mj sync push --dir " + generatedDir);
    expect(recordedCommands).toContain("mj sync push --dir " + generatedDir);
    expect(recordedCommands).toContain("EXECUTED: mj sync push --dir " + generatedDir);

    // Acceptance: assert validation passed
    expect(result.passed).toBe(true);
    expect(result.validation.passed).toBe(true);
    expect(result.validation.failedCount).toBe(0);
  });

  it("proves pipeline aborts and skips push and playwright when validation fails", async () => {
    const recordedSteps: string[] = [];
    const pushMock = vi.fn();
    const abortDir = path.join(tempDir, "abort-validation");
    const abortBaseline = path.join(tempDir, "abort-baseline");

    // Create baseline and deliberately tamper with a file so validation fails after accumulate
    await fs.cp(baselineDir, abortBaseline, { recursive: true });

    // Tamper with Session.json in baseline to inject corrupted dates that will break item-inside-session upon accumulate
    const sessionFile = path.join(abortBaseline, "Session", "Session.json");
    const sessionJson = JSON.parse(await fs.readFile(sessionFile, "utf8"));
    for (const s of sessionJson) {
      s.fields.StartDate = "2099-01-01";
      s.fields.EndDate = "2099-01-02";
    }
    await fs.writeFile(sessionFile, JSON.stringify(sessionJson, null, 2));

    const result = await weeklyCycle({
      projectDir: govFixturePath,
      priorStateDir: abortBaseline,
      generatedDir: abortDir,
      cycles: 1,
      seed: 42,
      enableVisualInspection: true,
      explorerUrl: "http://localhost:4200",
      routesToInspect: ["/governance"],
      recordStep: (step) => {
        recordedSteps.push(step);
      },
      executePush: pushMock,
    });

    // Proven: validation failed
    expect(result.passed).toBe(false);
    expect(result.validation.passed).toBe(false);

    // Proven: pipeline halted after validate; push and playwright were NEVER called
    expect(result.executionOrder).toEqual(["accumulate", "validate"]);
    expect(recordedSteps).toEqual(["accumulate", "validate"]);
    expect(recordedSteps).not.toContain("push");
    expect(recordedSteps).not.toContain("playwright");
    expect(pushMock).not.toHaveBeenCalled();
    expect(result.visualInspection).toBeUndefined();
  });

  it("proves pipeline aborts and skips playwright when push throws an error", async () => {
    const recordedSteps: string[] = [];
    const pushError = new Error("MJAPI network error during mj sync push");
    const pushFailingMock = vi.fn().mockRejectedValue(pushError);
    const pushAbortDir = path.join(tempDir, "abort-push");

    await expect(
      weeklyCycle({
        projectDir: govFixturePath,
        priorStateDir: baselineDir,
        generatedDir: pushAbortDir,
        cycles: 1,
        seed: 42,
        enableVisualInspection: true,
        explorerUrl: "http://localhost:4200",
        routesToInspect: ["/governance"],
        recordStep: (step) => {
          recordedSteps.push(step);
        },
        executePush: pushFailingMock,
      })
    ).rejects.toThrow("MJAPI network error during mj sync push");

    // Proven: accumulate, validate, and push were invoked, but playwright was NEVER called
    expect(recordedSteps).toEqual(["accumulate", "validate", "push"]);
    expect(recordedSteps).not.toContain("playwright");
    expect(pushFailingMock).toHaveBeenCalledTimes(1);
  });
});

describe("runWeeklySimulationCycle (legacy in-memory)", () => {
  const domain: DomainConfig = {
    name: "test-weekly",
    namespace: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    entities: {
      Organization: {
        name: "Organization",
        targetTable: "Organization",
        schema: "dbo",
        pack: "common",
        businessKey: ["ID"],
        fields: {},
        foreignKeys: {},
        isImmutable: false,
      },
    },
    packs: {
      common: { name: "common", dependsOn: [] },
    },
  };

  it("runs complete in-memory cycle: computes deltas and passes validation gates", async () => {
    const priorState = {
      Organization: [{ ID: "org-1", Name: "Org 1" }],
    };

    const currentState = {
      Organization: [
        { ID: "org-1", Name: "Org 1" },
        { ID: "org-2", Name: "Org 2" },
      ],
    };

    const result = await runWeeklySimulationCycle({
      domain,
      cycleIndex: 1,
      asOfDate: "2026-09-02",
      priorState,
      currentState,
      enableVisualInspection: false,
    });

    expect(result.passed).toBe(true);
    expect(result.cycleIndex).toBe(1);
    expect(result.newRecordCounts["Organization"]).toBe(1);
    expect(result.validation.passed).toBe(true);
  });
});
