import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { IdentityService } from "@memberjunction/loom-engine";
import type { AccumulatePlan, DomainConfig } from "@memberjunction/loom-contracts";
import { executeBuild } from "../src/commands/build.js";
import { executeAccumulate } from "../src/commands/accumulate.js";
import { applyAccumulatePlan, loadAccumulatePlan } from "../src/plan.js";

// A small composed domain: a header with a collection of lines, one line subtype (IsA), a catalog,
// and a natural-keyed sequence. Entity names are test-local; Loom's src stays domain-neutral.
const field = (name: string, type = "string", extra: Record<string, unknown> = {}) => ({ name, type, ...extra });
const domain = {
  name: "plan-test",
  namespace: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
  packs: { core: { name: "core", dependsOn: [] } },
  entities: {
    Customer: {
      name: "Customer", entityName: "Customer", targetTable: "Customer", schema: "s", pack: "core", businessKey: ["Email"],
      fields: { ID: field("ID", "uuid", { isPrimaryKey: true }), Name: field("Name"), Email: field("Email"), Joined: field("Joined", "date"), Tier: field("Tier", "string", { defaultValue: "Standard" }) },
      foreignKeys: {}, isImmutable: false,
    },
    Item: {
      name: "Item", entityName: "Item", targetTable: "Item", schema: "s", pack: "core", businessKey: ["SKU"],
      fields: { ID: field("ID", "uuid", { isPrimaryKey: true }), SKU: field("SKU"), Price: field("Price", "number") },
      foreignKeys: {}, isImmutable: false,
    },
    Header: {
      name: "Header", entityName: "Header", targetTable: "Header", schema: "s", pack: "core", businessKey: ["Number"],
      fields: { ID: field("ID", "uuid", { isPrimaryKey: true }), Number: field("Number"), CustomerID: field("CustomerID", "uuid"), Total: field("Total", "number") },
      foreignKeys: { CustomerID: { targetEntity: "Customer", targetField: "ID" } }, isImmutable: false,
      composition: { collections: { Lines: { entity: "Line", foreignKey: "HeaderID", mode: "upsert" } } },
    },
    Line: {
      name: "Line", entityName: "Line", targetTable: "Line", schema: "s", pack: "core",
      fields: { ID: field("ID", "uuid", { isPrimaryKey: true }), HeaderID: field("HeaderID", "uuid"), ItemID: field("ItemID", "uuid"), Amount: field("Amount", "number") },
      foreignKeys: { HeaderID: { targetEntity: "Header", targetField: "ID", dependent: true }, ItemID: { targetEntity: "Item", targetField: "ID" } }, isImmutable: false,
    },
    TicketLine: {
      name: "TicketLine", entityName: "TicketLine", targetTable: "TicketLine", schema: "s", pack: "core",
      fields: { ID: field("ID", "uuid", { isPrimaryKey: true }), AttendeeID: field("AttendeeID", "uuid"), Seat: field("Seat") },
      foreignKeys: { AttendeeID: { targetEntity: "Customer", targetField: "ID" } }, isImmutable: false,
      composition: { isA: { parentEntity: "Line" } },
    },
    Sequence: {
      name: "Sequence", entityName: "Sequence", targetTable: "Sequence", schema: "s", pack: "core",
      fields: { Scope: field("Scope", "string", { isPrimaryKey: true }), Next: field("Next", "number") },
      foreignKeys: {}, isImmutable: false,
    },
  },
} as unknown as DomainConfig;

const existing = () => ({
  Customer: [{ ID: "11111111-1111-4111-8111-111111111111", Name: "Ada Existing", Email: "ada@example.test" }],
  Item: [
    { ID: "22222222-2222-4222-8222-222222222222", SKU: "MEM-1", Price: 120 },
    { ID: "33333333-3333-4333-8333-333333333333", SKU: "EVT-1", Price: 300 },
  ],
  Header: [] as Record<string, unknown>[],
  Line: [] as Record<string, unknown>[],
  TicketLine: [] as Record<string, unknown>[],
  Sequence: [{ Scope: "A", Next: 1 }],
});
const apply = (plan: Partial<AccumulatePlan>, records = existing()) => {
  const ids = new IdentityService();
  ids.RegisterNamespace(domain.name, domain.namespace);
  const result = applyAccumulatePlan({ domain, plan: { asOf: "2026-10-31", intake: {}, records: [], ...plan }, records, identityService: ids });
  return { result, records };
};

describe("applyAccumulatePlan", () => {
  const goodPlan: Partial<AccumulatePlan> = {
    records: [
      { entity: "Customer", ref: "bea", fields: { Name: "Bea Planned", Email: "bea@example.test", Joined: "2026-10-04" } },
      { entity: "Header", ref: "h1", fields: { Number: "H-100", CustomerID: { ref: "bea" }, Total: 420 } },
      { entity: "Line", ref: "l1", fields: { HeaderID: { ref: "h1" }, ItemID: { lookup: { SKU: "MEM-1" } }, Amount: 120 } },
      { entity: "Line", ref: "l2", fields: { HeaderID: { ref: "h1" }, ItemID: { lookup: { SKU: "EVT-1" } }, Amount: 300 } },
      { entity: "TicketLine", extends: "l2", fields: { AttendeeID: { lookup: { Email: "ada@example.test" } }, Seat: "B4" } },
    ],
  };

  it("appends planned rows with minted keys, resolved refs and lookups, and defaults", () => {
    const { result, records } = apply(goodPlan);
    expect(result.added).toEqual({ Customer: 1, Header: 1, Line: 2, TicketLine: 1 });
    const bea = records.Customer[1]!;
    expect(bea).toMatchObject({ Name: "Bea Planned", Tier: "Standard" });
    // Declared fields nobody supplied or generated are written as null, never as placeholders
    expect(records.TicketLine[0]).toHaveProperty("ID");
    expect(records.Header[0]).toMatchObject({ Total: 420 });
    expect(result.nulled).toEqual({});
    const header = records.Header[0]!;
    expect(header["CustomerID"]).toBe(bea["ID"]);
    const [l1, l2] = records.Line;
    expect(l1!["HeaderID"]).toBe(header["ID"]);
    expect(l1!["ItemID"]).toBe("22222222-2222-4222-8222-222222222222");
    // The IsA child shares its parent's key, which is how it composes as the parent's extension
    expect(records.TicketLine[0]!["ID"]).toBe(l2!["ID"]);
    expect(records.TicketLine[0]!["AttendeeID"]).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("writes null for declared fields the plan left out, and reports them", () => {
    const { result, records } = apply({ records: [{ entity: "Customer", fields: { Email: "cal@example.test" } }] });
    expect(records.Customer[1]).toMatchObject({ Email: "cal@example.test", Name: null, Joined: null, Tier: "Standard" });
    expect(result.nulled).toEqual({ Customer: ["Joined", "Name"] });
  });

  it("mints the same keys for the same plan, and business-keyed rows get the key a generated row would", () => {
    const a = apply(goodPlan).records;
    const b = apply(goodPlan).records;
    expect(a.Header[0]!["ID"]).toBe(b.Header[0]!["ID"]);
    const ids = new IdentityService();
    ids.RegisterNamespace(domain.name, domain.namespace);
    expect(a.Header[0]!["ID"]).toBe(ids.MintId(domain.name, "Header", ["H-100"]));
  });

  it("collects every problem and adds nothing when the plan is wrong", () => {
    const records = existing();
    const before = JSON.stringify(records);
    let message = "";
    try {
      apply({
        records: [
          { entity: "Customer", ref: "x", fields: { Nmae: "typo", Email: "x@example.test" } },
          { entity: "Header", fields: { Number: "H-1", CustomerID: { ref: "nobody" }, Total: "lots" } },
          { entity: "Line", fields: { ItemID: { lookup: { SKU: "NOPE" } } } },
          { entity: "Customer", fields: { Email: "ada@example.test" } },
          { entity: "Ghost", fields: {} },
        ],
      }, records);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/unknown entity 'Ghost'/);
    expect(JSON.stringify(records)).toBe(before);
    // Fix the unknown entity and the rest are reported together
    try {
      apply({
        records: [
          { entity: "Customer", ref: "x", fields: { Nmae: "typo", Email: "x@example.test" } },
          { entity: "Header", fields: { Number: "H-1", CustomerID: { ref: "nobody" }, Total: "lots" } },
          { entity: "Line", fields: { ItemID: { lookup: { SKU: "NOPE" } } } },
        ],
      }, records);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Customer has no field 'Nmae'/);
    expect(message).toMatch(/refers to 'nobody', which is not a ref/);
    expect(message).toMatch(/Header.Total is a number, got "lots"/);
    expect(message).toMatch(/lookup Item where SKU="NOPE" matched 0 records/);
    expect(message).toMatch(/HeaderID is required/);
    expect(JSON.stringify(records)).toBe(before);
  });

  it("rejects a key that already exists, a supplied ID, and a bad extends", () => {
    // Same business key as an existing row, whatever that row's ID: a duplicate
    expect(() => apply({ records: [{ entity: "Customer", fields: { Email: "ADA@example.test" } }] })).toThrow(/a Customer with Email "ADA@example.test" already exists/);
    // Same minted key as an existing row
    const ids = new IdentityService();
    ids.RegisterNamespace(domain.name, domain.namespace);
    const minted = { ...existing(), Customer: [{ ID: ids.MintId(domain.name, "Customer", ["new@example.test"]), Email: "renamed@example.test" }] };
    expect(() => apply({ records: [{ entity: "Customer", fields: { Email: "new@example.test" } }] }, minted)).toThrow(/with ID .* already exists/);
    expect(() => apply({ records: [{ entity: "Item", fields: { ID: "44444444-4444-4444-8444-444444444444", SKU: "X" } }] })).toThrow(/do not supply ID/);
    expect(() => apply({ records: [{ entity: "TicketLine", fields: { Seat: "A1" } }] })).toThrow(/name the planned parent with "extends"/);
    expect(() => apply({ records: [{ entity: "Customer", ref: "c", fields: { Email: "c@example.test" } }, { entity: "TicketLine", extends: "c", fields: {} }] })).toThrow(/but TicketLine extends Line/);
  });

  it("takes natural keys from the plan and refuses an ambiguous lookup", () => {
    const { records } = apply({ records: [{ entity: "Sequence", fields: { Scope: "B", Next: 1 } }] });
    expect(records.Sequence[1]).toEqual({ Scope: "B", Next: 1 });
    expect(() => apply({ records: [{ entity: "Sequence", fields: { Next: 1 } }] })).toThrow(/keyed by Scope; supply Scope/);
    const twin = { ...existing(), Item: [...existing().Item, { ID: "55555555-5555-4555-8555-555555555555", SKU: "MEM-1", Price: 1 }] };
    expect(() => apply({ records: [{ entity: "Header", ref: "h", fields: { Number: "H-2" } }, { entity: "Line", fields: { HeaderID: { ref: "h" }, ItemID: { lookup: { SKU: "MEM-1" } } } }] }, twin)).toThrow(/matched 2 records/);
  });
});

describe("loadAccumulatePlan", () => {
  const dir = path.join(os.tmpdir(), "loom-plan-load-" + Date.now());
  beforeAll(() => fs.mkdir(dir, { recursive: true }));
  afterAll(() => fs.rm(dir, { recursive: true, force: true }));

  it("names the bad paths in an invalid plan", async () => {
    const f = path.join(dir, "bad.json");
    await fs.writeFile(f, JSON.stringify({ asOf: "Oct 2026", records: [{ entity: "X", fields: { A: { lookup: {} } }, extra: 1 }] }));
    await expect(loadAccumulatePlan(f)).rejects.toThrow(/asOf: asOf must be YYYY-MM-DD/);
  });
});

describe("accumulate --plan on the More Cheese fixture", () => {
  const fixtureDataPath = path.resolve(__dirname, "fixtures/more-cheese-data");
  const tempDir = path.join(os.tmpdir(), "loom-accum-plan-" + Date.now());
  const projectDir = path.join(tempDir, "project");
  const baselineDir = path.join(tempDir, "baseline");

  beforeAll(async () => {
    await fs.cp(fixtureDataPath, projectDir, { recursive: true });
    const rulesetPath = path.join(projectDir, "ruleset", "common.json");
    const ruleset = JSON.parse(await fs.readFile(rulesetPath, "utf8"));
    for (const key of Object.keys(ruleset.params)) if (key.startsWith("intake_")) delete ruleset.params[key];
    ruleset.params.intake_default = 0;
    await fs.writeFile(rulesetPath, JSON.stringify(ruleset, null, 2));
    await executeBuild({ project: projectDir, seed: "42", output: baselineDir });
  });
  afterAll(() => fs.rm(tempDir, { recursive: true, force: true }));

  const baselineAsOf = async () => JSON.parse(await fs.readFile(path.join(baselineDir, "checkpoint.json"), "utf8")).continuity.asOfDate as string;
  const writePlan = async (name: string, plan: unknown) => {
    const f = path.join(tempDir, name);
    await fs.writeFile(f, JSON.stringify(plan));
    return f;
  };
  const nextAsOf = async () => {
    const { advanceDateByCycle } = await import("../src/commands/accumulate.js");
    const project = JSON.parse(await fs.readFile(path.join(projectDir, "project.json"), "utf8"));
    return advanceDateByCycle(await baselineAsOf(), 1, project.cycleUnit ?? "year");
  };

  it("appends exactly the planned records, records the plan in the checkpoint, and stays append-only", async () => {
    const asOf = await nextAsOf();
    const planFile = await writePlan("plan.json", {
      asOf,
      summary: "two named members join; one enrolls",
      records: [
        { entity: "Person", ref: "p1", fields: { FirstName: "Marisol", LastName: "Okonkwo", Email: "marisol.okonkwo@example.test", Status: "Active" } },
        { entity: "Person", ref: "p2", fields: { FirstName: "Tobias", LastName: "Lindqvist", Email: "tobias.lindqvist@example.test", Status: "Active" } },
        { entity: "CourseEnrollment", fields: { EnrollKey: "ENR-PLAN-1", PersonID: { ref: "p1" }, EnrolledOn: asOf, Status: "Enrolled" } },
      ],
    });
    const out = path.join(tempDir, "planned");
    await executeAccumulate({ project: projectDir, priorState: baselineDir, output: out, cycles: "1", plan: planFile });
    const diff = execSync(`diff -r -x checkpoint.json ${baselineDir} ${out} || true`).toString();
    expect(diff.split("\n").filter((l) => l.startsWith("< ")).every((l) => l.trim() === "< }")).toBe(true);
    expect(diff).toMatch(/Marisol/);
    expect(diff).toMatch(/Tobias/);
    expect(diff).toMatch(/ENR-PLAN-1/);
    expect(diff).not.toMatch(/MemberFirst/);
    const checkpoint = JSON.parse(await fs.readFile(path.join(out, "checkpoint.json"), "utf8"));
    expect(checkpoint.continuity.metadata.plan).toMatchObject({ summary: "two named members join; one enrolls", records: 3, added: { Person: 2, CourseEnrollment: 1 } });
  });

  it("refuses a plan written for a different cycle, and a bad plan, without writing anything", async () => {
    const wrong = await writePlan("wrong.json", { asOf: "1999-12-31", records: [] });
    const out = path.join(tempDir, "refused");
    await expect(executeAccumulate({ project: projectDir, priorState: baselineDir, output: out, cycles: "1", plan: wrong })).rejects.toThrow(/plan is for as-of 1999-12-31/);
    const bad = await writePlan("bad.json", { asOf: await nextAsOf(), records: [{ entity: "Person", fields: { Shoe: 9 } }] });
    await expect(executeAccumulate({ project: projectDir, priorState: baselineDir, output: out, cycles: "1", plan: bad })).rejects.toThrow(/Person has no field 'Shoe'/);
    await expect(fs.access(out)).rejects.toThrow();
  });
});
