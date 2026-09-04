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

  it("proves Abstain votes are generated from declared abstainRate (R3-1)", async () => {
    const ballotFile = path.join(build1Dir, "Ballot", "Ballot.json");
    const ballots = JSON.parse(await fs.readFile(ballotFile, "utf8")) as Array<{ fields: { Vote: string } }>;
    const abstainCount = ballots.filter((b) => b.fields.Vote === "Abstain").length;
    expect(abstainCount).toBeGreaterThan(0);
  });

  it("proves child event offsets are drawn from timing distribution and not all equal (R3-2)", async () => {
    const sessionFile = path.join(build1Dir, "Session", "Session.json");
    const itemFile = path.join(build1Dir, "Item", "Item.json");
    const sessions = JSON.parse(await fs.readFile(sessionFile, "utf8")) as Array<{ primaryKey: { ID: string }; fields: { StartDate: string } }>;
    const items = JSON.parse(await fs.readFile(itemFile, "utf8")) as Array<{ fields: { SessionID: string; ItemDate: string } }>;
    const sessionMap = new Map(sessions.map((s) => [s.primaryKey.ID, s.fields.StartDate]));

    const offsetDays = items.map((item) => {
      const sessionStart = sessionMap.get(item.fields.SessionID);
      expect(sessionStart).toBeDefined();
      const diffMs = new Date(item.fields.ItemDate).getTime() - new Date(sessionStart!).getTime();
      return Math.round(diffMs / (1000 * 60 * 60 * 24));
    });

    const distinctOffsets = new Set(offsetDays);
    expect(distinctOffsets.size).toBeGreaterThan(1);
  });

  it("proves tenure windows exclude inactive holders so eligible count is below holder count (R3-3)", async () => {
    const tenureFile = path.join(build1Dir, "Tenure", "Tenure.json");
    const decisionFile = path.join(build1Dir, "Decision", "Decision.json");
    const ballotFile = path.join(build1Dir, "Ballot", "Ballot.json");
    const itemFile = path.join(build1Dir, "Item", "Item.json");
    const sessionFile = path.join(build1Dir, "Session", "Session.json");

    const tenures = JSON.parse(await fs.readFile(tenureFile, "utf8")) as Array<{ fields: { BodyID: string; ActorID: string } }>;
    const decisions = JSON.parse(await fs.readFile(decisionFile, "utf8")) as Array<{ primaryKey: { ID: string }; fields: { ItemID: string } }>;
    const ballots = JSON.parse(await fs.readFile(ballotFile, "utf8")) as Array<{ fields: { DecisionID: string; ActorID: string } }>;
    const items = JSON.parse(await fs.readFile(itemFile, "utf8")) as Array<{ primaryKey: { ID: string }; fields: { SessionID: string } }>;
    const sessions = JSON.parse(await fs.readFile(sessionFile, "utf8")) as Array<{ primaryKey: { ID: string }; fields: { BodyID: string } }>;

    const itemToSession = new Map(items.map((i) => [i.primaryKey.ID, i.fields.SessionID]));
    const sessionToBody = new Map(sessions.map((s) => [s.primaryKey.ID, s.fields.BodyID]));

    let foundDecisionBelowHolders = false;
    for (const decision of decisions) {
      const sessionId = itemToSession.get(decision.fields.ItemID);
      const bodyId = sessionId ? sessionToBody.get(sessionId) : undefined;
      expect(bodyId).toBeDefined();

      const totalHoldersForBody = tenures.filter((t) => t.fields.BodyID === bodyId).length;
      const eligibleBallots = ballots.filter((b) => b.fields.DecisionID === decision.primaryKey.ID).length;

      expect(totalHoldersForBody).toBeGreaterThan(0);
      expect(eligibleBallots).toBeGreaterThan(0);
      if (eligibleBallots < totalHoldersForBody) {
        foundDecisionBelowHolders = true;
      }
    }
    expect(foundDecisionBelowHolders).toBe(true);
  });

  it("guarantees hero non-interference: non-hero rows remain identical", async () => {
    const tempGovFixture = path.join(tempDir, "gov-fixture-no-hero");
    await fs.cp(govFixturePath, tempGovFixture, { recursive: true });
    const heroesFile = path.join(tempGovFixture, "ruleset", "heroes.json");
    await fs.writeFile(heroesFile, JSON.stringify({ heroes: [] }, null, 2));
    await executeBuild({
      project: tempGovFixture,
      seed: "42",
      output: noHeroBuildDir,
    });

    // Body differs because hero record HERO-GOV-001 is injected in build1Dir
    const withHeroBodyRaw = await fs.readFile(path.join(build1Dir, "Body", "Body.json"), "utf8");
    const noHeroBodyRaw = await fs.readFile(path.join(noHeroBuildDir, "Body", "Body.json"), "utf8");
    expect(withHeroBodyRaw).not.toBe(noHeroBodyRaw);

    const withHeroBody = JSON.parse(withHeroBodyRaw) as Array<{ primaryKey: { ID: string }; fields: { Name: string } }>;
    const noHeroBody = JSON.parse(noHeroBodyRaw) as Array<{ primaryKey: { ID: string }; fields: { Name: string } }>;
    expect(withHeroBody.length).toBe(noHeroBody.length + 1);
    const nonHeroWithHeroBody = withHeroBody.filter((b) => b.fields.Name !== "Hero Governing Board");
    expect(JSON.stringify(nonHeroWithHeroBody)).toBe(JSON.stringify(noHeroBody));

    // All child and dependent entities are 100% byte-identical
    const entities = ["Tenure", "Session", "Item", "Decision", "Ballot"];
    for (const entity of entities) {
      const withHeroData = await fs.readFile(path.join(build1Dir, entity, entity + ".json"), "utf8");
      const noHeroData = await fs.readFile(path.join(noHeroBuildDir, entity, entity + ".json"), "utf8");
      expect(withHeroData).toBe(noHeroData);
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

  it("mutation 4 fails: quorum requirement not met fails decision-outcome-derived-from-ballots", async () => {
    const mutantProjDir = path.join(tempDir, "mutant-proj-quorum");
    await fs.cp(govFixturePath, mutantProjDir, { recursive: true });

    // Set quorum to 9999 in domain.json
    const domainPath = path.join(mutantProjDir, "domain.json");
    const domainJson = JSON.parse(await fs.readFile(domainPath, "utf8"));
    const rule = domainJson.relationalRules.find((r: { kind: string }) => r.kind === "outcome-derived-from-ballots");
    rule.quorum = 9999;
    await fs.writeFile(domainPath, JSON.stringify(domainJson, null, 2));

    const report = await executeValidate({
      project: mutantProjDir,
      data: build1Dir,
    });

    expect(report.passed).toBe(false);
    const brokenGate = report.gates.find((g) => g.name.includes("decision-outcome-derived-from-ballots"));
    expect(brokenGate).toBeDefined();
    expect(brokenGate?.passed).toBe(false);
    expect(brokenGate?.actual).toBeGreaterThan(0);
  });

  it("mutation 5 fails: tie-break rule violation fails decision-outcome-derived-from-ballots", async () => {
    const mutantProjDir = path.join(tempDir, "mutant-proj-tie");
    const mutantDataDir = path.join(tempDir, "mutant-data-tie");
    await fs.cp(govFixturePath, mutantProjDir, { recursive: true });
    await fs.cp(build1Dir, mutantDataDir, { recursive: true });

    // In domain.json set tieRule to Failed
    const domainPath = path.join(mutantProjDir, "domain.json");
    const domainJson = JSON.parse(await fs.readFile(domainPath, "utf8"));
    const rule = domainJson.relationalRules.find((r: { kind: string }) => r.kind === "outcome-derived-from-ballots");
    rule.tieRule = "Failed";
    await fs.writeFile(domainPath, JSON.stringify(domainJson, null, 2));

    // In mutant data, find first decision that is Passed, and set its ballots to 5 Yes, 5 No (tie)
    const decisionFile = path.join(mutantDataDir, "Decision", "Decision.json");
    const decisions = JSON.parse(await fs.readFile(decisionFile, "utf8"));
    const targetDecision = decisions.find((d: { fields: { Outcome: string } }) => d.fields.Outcome === "Passed") ?? decisions[0];
    targetDecision.fields.Outcome = "Passed";
    await fs.writeFile(decisionFile, JSON.stringify(decisions, null, 2));

    const ballotFile = path.join(mutantDataDir, "Ballot", "Ballot.json");
    const ballots = JSON.parse(await fs.readFile(ballotFile, "utf8"));
    const targetDecisionId = targetDecision.primaryKey.ID;
    const targetBallots = ballots.filter((b: { fields: { DecisionID: string } }) => b.fields.DecisionID === targetDecisionId);
    // Mutate ballots: exactly half Yes, half No
    const half = Math.floor(targetBallots.length / 2);
    targetBallots.forEach((b: { fields: { Vote: string } }, idx: number) => {
      b.fields.Vote = idx < half ? "Yes" : "No";
    });
    if (targetBallots.length % 2 !== 0 && targetBallots.length > 0) {
      targetBallots[targetBallots.length - 1].fields.Vote = "No";
    }
    await fs.writeFile(ballotFile, JSON.stringify(ballots, null, 2));

    const report = await executeValidate({
      project: mutantProjDir,
      data: mutantDataDir,
    });

    expect(report.passed).toBe(false);
    const brokenGate = report.gates.find((g) => g.name.includes("decision-outcome-derived-from-ballots"));
    expect(brokenGate).toBeDefined();
    expect(brokenGate?.passed).toBe(false);
    expect(brokenGate?.actual).toBeGreaterThan(0);
  });

  it("mutation 6 fails: abstain votes ignored below quorum fails decision-outcome-derived-from-ballots", async () => {
    const mutantProjDir = path.join(tempDir, "mutant-proj-abstain");
    const mutantDataDir = path.join(tempDir, "mutant-data-abstain");
    await fs.cp(govFixturePath, mutantProjDir, { recursive: true });
    await fs.cp(build1Dir, mutantDataDir, { recursive: true });

    // Set quorum to 30 and abstainHandling to 'ignore' in domain.json
    const domainPath = path.join(mutantProjDir, "domain.json");
    const domainJson = JSON.parse(await fs.readFile(domainPath, "utf8"));
    const rule = domainJson.relationalRules.find((r: { kind: string }) => r.kind === "outcome-derived-from-ballots");
    rule.quorum = 30;
    rule.abstainHandling = "ignore";
    await fs.writeFile(domainPath, JSON.stringify(domainJson, null, 2));

    // Find a decision that is Passed, and change most ballots to Abstain so active votes (Yes + No) < 30
    const decisionFile = path.join(mutantDataDir, "Decision", "Decision.json");
    const decisions = JSON.parse(await fs.readFile(decisionFile, "utf8"));
    const targetDecision = decisions.find((d: { fields: { Outcome: string } }) => d.fields.Outcome === "Passed") ?? decisions[0];
    targetDecision.fields.Outcome = "Passed";
    await fs.writeFile(decisionFile, JSON.stringify(decisions, null, 2));

    const ballotFile = path.join(mutantDataDir, "Ballot", "Ballot.json");
    const ballots = JSON.parse(await fs.readFile(ballotFile, "utf8"));
    const targetDecisionId = targetDecision.primaryKey.ID;
    const targetBallots = ballots.filter((b: { fields: { DecisionID: string } }) => b.fields.DecisionID === targetDecisionId);
    // 5 Yes, 5 No, rest Abstain (total Yes+No = 10 < 30 quorum)
    targetBallots.forEach((b: { fields: { Vote: string } }, idx: number) => {
      b.fields.Vote = idx < 5 ? "Yes" : (idx < 10 ? "No" : "Abstain");
    });
    await fs.writeFile(ballotFile, JSON.stringify(ballots, null, 2));

    const report = await executeValidate({
      project: mutantProjDir,
      data: mutantDataDir,
    });

    expect(report.passed).toBe(false);
    const brokenGate = report.gates.find((g) => g.name.includes("decision-outcome-derived-from-ballots"));
    expect(brokenGate).toBeDefined();
    expect(brokenGate?.passed).toBe(false);
    expect(brokenGate?.actual).toBeGreaterThan(0);
  });

  it("mutation 7 fails: custom abstainVoteValue 'Abstained' mismatch fails quorum check (R4-2)", async () => {
    const mutantProjDir = path.join(tempDir, "mutant-proj-custom-abstain");
    const mutantDataDir = path.join(tempDir, "mutant-data-custom-abstain");
    await fs.cp(govFixturePath, mutantProjDir, { recursive: true });
    await fs.cp(build1Dir, mutantDataDir, { recursive: true });

    // In domain.json, set abstainVoteValue to "Abstained", quorum to 3, and abstainHandling to "count-toward-quorum"
    const domainPath = path.join(mutantProjDir, "domain.json");
    const domainJson = JSON.parse(await fs.readFile(domainPath, "utf8"));
    const rule = domainJson.relationalRules.find((r: { kind: string }) => r.kind === "outcome-derived-from-ballots");
    rule.abstainVoteValue = "Abstained";
    rule.quorum = 3;
    rule.abstainHandling = "count-toward-quorum";
    await fs.writeFile(domainPath, JSON.stringify(domainJson, null, 2));

    // In mutant data, find first decision that is Passed
    const decisionFile = path.join(mutantDataDir, "Decision", "Decision.json");
    const decisions = JSON.parse(await fs.readFile(decisionFile, "utf8"));
    const targetDecision = decisions[0];
    targetDecision.fields.Outcome = "Passed";
    await fs.writeFile(decisionFile, JSON.stringify(decisions, null, 2));

    // Ballots have "Abstain" (not the declared "Abstained").
    // Because validator checks against rule.abstainVoteValue ("Abstained"),
    // "Abstain" is not counted toward quorum, giving participants = 1 < 3 quorum, failing the gate.
    const ballotFile = path.join(mutantDataDir, "Ballot", "Ballot.json");
    const ballots = JSON.parse(await fs.readFile(ballotFile, "utf8"));
    const targetDecisionId = targetDecision.primaryKey.ID;
    const targetBallots = ballots.filter((b: { fields: { DecisionID: string } }) => b.fields.DecisionID === targetDecisionId);

    targetBallots.forEach((b: { fields: { Vote: string } }, idx: number) => {
      b.fields.Vote = idx === 0 ? "Yes" : "Abstain";
    });
    await fs.writeFile(ballotFile, JSON.stringify(ballots, null, 2));

    const report = await executeValidate({
      project: mutantProjDir,
      data: mutantDataDir,
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
