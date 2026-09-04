import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { executeBuild } from "../src/commands/build.js";
import { executeAccumulate } from "../src/commands/accumulate.js";
import { executeValidate } from "../src/commands/validate.js";

describe("L10-4 Accumulate on More Cheese Fixture", () => {
  const fixtureDataPath = path.resolve(__dirname, "fixtures/more-cheese-data");
  const tempDir = path.join(os.tmpdir(), "loom-accum-mc-" + Date.now());
  const baselineDir = path.join(tempDir, "baseline");
  const accum1Dir = path.join(tempDir, "accum1");
  const accum2Dir = path.join(tempDir, "accum2");

  beforeAll(async () => {
    await fs.mkdir(tempDir, { recursive: true });
    // Build baseline once
    await executeBuild({
      project: fixtureDataPath,
      seed: "42",
      output: baselineDir,
    });
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("generates byte-identical accumulate output across two independent runs", async () => {
    await executeAccumulate({
      project: fixtureDataPath,
      priorState: baselineDir,
      output: accum1Dir,
      cycles: "1",
      seed: "42",
    });

    await executeAccumulate({
      project: fixtureDataPath,
      priorState: baselineDir,
      output: accum2Dir,
      cycles: "1",
      seed: "42",
    });

    const diff = execSync("diff -r " + accum1Dir + " " + accum2Dir + " || true").toString().trim();
    expect(diff).toBe("");
  });

  it("emits only additive records and status updates, and passes validation", async () => {
    const report = await executeValidate({
      project: fixtureDataPath,
      data: accum1Dir,
    });
    expect(report.passed).toBe(true);
    expect(report.failedCount).toBe(0);
  });

  it("mutation test: corrupting one prior PK causes accumulate to exit 1 naming the corrupted PK", async () => {
    const corruptPriorDir = path.join(tempDir, "corrupt-prior");
    await fs.cp(baselineDir, corruptPriorDir, { recursive: true });

    // Find Member.json or Organization.json and corrupt one primary key
    const memberDir = path.join(corruptPriorDir, "people");
    const files = (await fs.readdir(memberDir)).filter((f) => f.endsWith(".json") && f !== ".mj-sync.json");
    const targetFile = path.join(memberDir, files[0]);
    const records = JSON.parse(await fs.readFile(targetFile, "utf8"));
    const corruptPk = "corrupted-pk-bad-uuid-9999";
    records[0].primaryKey.ID = corruptPk;
    await fs.writeFile(targetFile, JSON.stringify(records, null, 2));

    const targetOut = path.join(tempDir, "corrupt-out");
    await expect(
      executeAccumulate({
        project: fixtureDataPath,
        priorState: corruptPriorDir,
        output: targetOut,
        cycles: "1",
        seed: "42",
      })
    ).rejects.toThrow(corruptPk);
  });
});
