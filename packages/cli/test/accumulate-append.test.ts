import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import type { DomainConfig } from "@memberjunction/loom-contracts";
import { executeBuild } from "../src/commands/build.js";
import { executeAccumulate, resolveSharedScope } from "../src/commands/accumulate.js";

describe("Accumulate writes onto the committed tree", () => {
  const fixtureDataPath = path.resolve(__dirname, "fixtures/more-cheese-data");
  const tempDir = path.join(os.tmpdir(), "loom-accum-append-" + Date.now());
  const projectDir = path.join(tempDir, "project");
  const baselineDir = path.join(tempDir, "baseline");

  beforeAll(async () => {
    await fs.cp(fixtureDataPath, projectDir, { recursive: true });
    await executeBuild({ project: projectDir, seed: "42", output: baselineDir });
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function setIntake(params: Record<string, number>) {
    const rulesetPath = path.join(projectDir, "ruleset", "common.json");
    const ruleset = JSON.parse(await fs.readFile(rulesetPath, "utf8"));
    for (const key of Object.keys(ruleset.params)) {
      if (key.startsWith("intake_")) delete ruleset.params[key];
    }
    Object.assign(ruleset.params, params);
    await fs.writeFile(rulesetPath, JSON.stringify(ruleset, null, 2));
  }

  it("leaves every data file byte-identical when the cycle adds nothing", async () => {
    await setIntake({ intake_default: 0 });
    const out = path.join(tempDir, "zero");
    await executeAccumulate({ project: projectDir, priorState: baselineDir, output: out, cycles: "1", seed: "42" });
    const diff = execSync(`diff -r -x checkpoint.json ${baselineDir} ${out} || true`).toString().trim();
    expect(diff).toBe("");
  });

  it("only adds lines to existing files when the cycle adds records", async () => {
    await setIntake({ intake_default: 0, intake_Person: 3 });
    const out = path.join(tempDir, "grow");
    await executeAccumulate({ project: projectDir, priorState: baselineDir, output: out, cycles: "1", seed: "42" });
    const diff = execSync(`diff -r -x checkpoint.json ${baselineDir} ${out} || true`).toString();
    const removed = diff.split("\n").filter((l) => l.startsWith("< "));
    // Appending to a JSON array rewrites only the closing "}" of the previous last record as "},"
    expect(removed.every((l) => l.trim() === "< }")).toBe(true);
    expect(diff).toMatch(/^>\s+"primaryKey"/m);
  });
});

describe("resolveSharedScope", () => {
  const entity = (name: string, fks: Record<string, string>) => ({
    name,
    entityName: name,
    targetTable: name,
    schema: "s",
    pack: "core",
    businessKey: ["ID"],
    fields: { ID: { name: "ID", type: "uuid", isPrimaryKey: true } },
    foreignKeys: Object.fromEntries(
      Object.entries(fks).map(([field, target]) => [field, { fieldName: field, targetEntity: target, targetField: "ID" }])
    ),
    isImmutable: false,
  });
  const domain = {
    name: "scope",
    namespace: "00000000-0000-0000-0000-0000000000b1",
    packs: { core: { name: "core", dependsOn: [] } },
    entities: {
      Person: entity("Person", {}),
      Committee: entity("Committee", {}),
      Term: entity("Term", { CommitteeID: "Committee" }),
      Membership: entity("Membership", { PersonID: "Person", TermID: "Term" }),
      Meeting: entity("Meeting", { CommitteeID: "Committee" }),
    },
  } as unknown as DomainConfig;
  const records = {
    Committee: [{ ID: "c1" }, { ID: "c2" }],
    Term: [{ ID: "t1", CommitteeID: "c1" }, { ID: "t2", CommitteeID: "c2" }],
    Membership: [{ ID: "m1", PersonID: "p1", TermID: "t1" }],
    Meeting: [{ ID: "g1", CommitteeID: "c1" }],
  };

  it("meets a membership and a meeting at their committee", () => {
    const scope = resolveSharedScope(domain, records, "Membership", "Meeting")!;
    expect(scope.scopeEntity).toBe("Committee");
    expect(scope.fromSource(records.Membership[0]!)).toBe("c1");
    expect(scope.fromTarget(records.Meeting[0]!)).toBe("c1");
  });

  it("returns undefined when the two share no ancestor", () => {
    expect(resolveSharedScope(domain, records, "Person", "Meeting")).toBeUndefined();
  });
});
