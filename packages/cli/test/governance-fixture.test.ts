import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { executeBuild } from "../src/commands/build.js";
import { executeValidate } from "../src/commands/validate.js";

describe("L10-3 Governance Fixture Testbed", () => {
  const govFixturePath = path.resolve(__dirname, "../../../projects/governance-fixture");
  const tempDir = path.join(os.tmpdir(), "loom-gov-fixture-" + Date.now());
  const build1Dir = path.join(tempDir, "build1");
  const build2Dir = path.join(tempDir, "build2");
  const noHeroBuildDir = path.join(tempDir, "noHeroBuild");

  beforeAll(async () => {
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("builds and validates cleanly with all relational integrity gates passed", async () => {
    await executeBuild({
      project: govFixturePath,
      seed: "42",
      output: build1Dir,
    });

    const report = await executeValidate({
      project: govFixturePath,
      data: build1Dir,
    });

    expect(report.passed).toBe(true);
    expect(report.failedCount).toBe(0);

    const relationalGates = report.gates.filter((g) => g.name.startsWith("Relational Integrity:"));
    expect(relationalGates.length).toBe(3);
    for (const g of relationalGates) {
      expect(g.passed).toBe(true);
      expect(g.populationCount).toBeGreaterThan(0);
    }
  });

  it("guarantees byte-identity between two builds with identical seed", async () => {
    await executeBuild({
      project: govFixturePath,
      seed: "42",
      output: build2Dir,
    });

    const diffOutput = execSync("diff -r " + build1Dir + " " + build2Dir + " || true").toString().trim();
    expect(diffOutput).toBe("");
  });

  it("guarantees hero non-interference: non-hero rows remain identical", async () => {
    const heroesFile = path.join(govFixturePath, "ruleset", "heroes.json");
    const originalHeroes = await fs.readFile(heroesFile, "utf8");
    try {
      await fs.writeFile(heroesFile, JSON.stringify({ heroes: [] }, null, 2));
      await executeBuild({
        project: govFixturePath,
        seed: "42",
        output: noHeroBuildDir,
      });

      const entities = ["Tenure", "Session", "Item", "Decision", "Ballot"];
      for (const entity of entities) {
        const withHeroData = await fs.readFile(path.join(build1Dir, entity, entity + ".json"), "utf8");
        const noHeroData = await fs.readFile(path.join(noHeroBuildDir, entity, entity + ".json"), "utf8");
        expect(withHeroData).toBe(noHeroData);
      }
    } finally {
      await fs.writeFile(heroesFile, originalHeroes);
    }
  });

  it("mutation 1 fails: item outside its session window fails childInsideParentWindow", async () => {
    const mutantDir = path.join(tempDir, "mutant-item-window");
    await fs.cp(build1Dir, mutantDir, { recursive: true });

    const itemFile = path.join(mutantDir, "Item", "Item.json");
    const itemRecords = JSON.parse(await fs.readFile(itemFile, "utf8"));
    itemRecords[0].fields.ItemDate = "2035-12-31";
    await fs.writeFile(itemFile, JSON.stringify(itemRecords, null, 2));

    const report = await executeValidate({
      project: govFixturePath,
      data: mutantDir,
    });

    expect(report.passed).toBe(false);
    const brokenGate = report.gates.find((g) => g.name.includes("item-inside-session"));
    expect(brokenGate).toBeDefined();
    expect(brokenGate?.passed).toBe(false);
    expect(brokenGate?.actual).toBeGreaterThan(0);
  });

  it("mutation 2 fails: ballot outside actor tenure fails actorRoleCoveringDate", async () => {
    const mutantDir = path.join(tempDir, "mutant-ballot-tenure");
    await fs.cp(build1Dir, mutantDir, { recursive: true });

    const ballotFile = path.join(mutantDir, "Ballot", "Ballot.json");
    const ballotRecords = JSON.parse(await fs.readFile(ballotFile, "utf8"));
    ballotRecords[0].fields.BallotDate = "2010-01-01";
    await fs.writeFile(ballotFile, JSON.stringify(ballotRecords, null, 2));

    const report = await executeValidate({
      project: govFixturePath,
      data: mutantDir,
    });

    expect(report.passed).toBe(false);
    const brokenGate = report.gates.find((g) => g.name.includes("ballot-actor-covered-by-tenure"));
    expect(brokenGate).toBeDefined();
    expect(brokenGate?.passed).toBe(false);
    expect(brokenGate?.actual).toBeGreaterThan(0);
  });

  it("mutation 3 fails: outcome disagreeing with ballots fails outcomeDerivedFromBallots", async () => {
    const mutantDir = path.join(tempDir, "mutant-decision-outcome");
    await fs.cp(build1Dir, mutantDir, { recursive: true });

    const decisionFile = path.join(mutantDir, "Decision", "Decision.json");
    const decisionRecords = JSON.parse(await fs.readFile(decisionFile, "utf8"));
    decisionRecords[0].fields.Outcome = decisionRecords[0].fields.Outcome === "Passed" ? "Failed" : "Passed";
    await fs.writeFile(decisionFile, JSON.stringify(decisionRecords, null, 2));

    const report = await executeValidate({
      project: govFixturePath,
      data: mutantDir,
    });

    expect(report.passed).toBe(false);
    const brokenGate = report.gates.find((g) => g.name.includes("decision-outcome-derived-from-ballots"));
    expect(brokenGate).toBeDefined();
    expect(brokenGate?.passed).toBe(false);
    expect(brokenGate?.actual).toBeGreaterThan(0);
  });

  it("verifies scripts/check-domain-vocabulary.mjs passes with 0 violations", () => {
    const rootDir = path.resolve(__dirname, "../../..");
    const result = execSync("node scripts/check-domain-vocabulary.mjs", {
      cwd: rootDir,
      encoding: "utf8",
    });
    expect(result).toContain("Zero domain vocabulary verified");
  });
});
