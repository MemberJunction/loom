import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DomainConfigSchema, LogoConfigSchema, AvatarConfigSchema } from "@memberjunction/loom-contracts";
import { AvatarGenerator, type DiceBearStyle } from "../src/avatars/AvatarGenerator.js";
import { LogoGenerator } from "../src/avatars/LogoGenerator.js";
import { applyFieldGenerators } from "../src/avatars/FieldGeneratorPass.js";
import { IdentityService } from "../src/identity/index.js";
import { Validator } from "../src/validation/validator.js";

const here = dirname(fileURLToPath(import.meta.url));
const moreCheeseOrgsPath = join(here, "fixtures/more-cheese-organizations.json");
const cheesePersonIdsPath = join(here, "fixtures/cheese-person-ids.json");

const TOON_TRAITS = {
  Female: { rearHairProbability: 100, beardProbability: 0 },
  Male: { rearHairProbability: 0, beardProbability: 40 },
};

const MICAH_TRAITS = {
  Female: { hair: ["pixie", "full"], facialHairProbability: 0 },
  Male: { hair: ["fonze", "mrT", "dannyPhantom"], facialHairProbability: 50 },
};

const LORELEI_TRAITS = {
  Female: { hair: ["variant01", "variant02", "variant03", "variant04"], beardProbability: 0 },
  Male: { hair: ["variant40", "variant41", "variant42", "variant43"], beardProbability: 50 },
};

const STYLE_TRAITS: Record<DiceBearStyle, Record<string, Record<string, unknown>>> = {
  "toon-head": TOON_TRAITS,
  micah: MICAH_TRAITS,
  lorelei: LORELEI_TRAITS,
};

function sampleDomain(fields: Record<string, unknown>) {
  return DomainConfigSchema.parse({
    name: "t",
    namespace: "00000000-0000-4000-8000-000000000001",
    entities: {
      Sample: {
        name: "Sample",
        entityName: "Sample",
        targetTable: "Sample",
        schema: "dbo",
        pack: "p",
        businessKey: ["ID"],
        fields,
      },
    },
    packs: { p: { name: "p" } },
  });
}

describe("AvatarGenerator (Loom Deterministic Profile Image Generation)", () => {
  const femaleSeed = "elena.rodriguez.000101@lakemail.example";
  const maleSeed = "marcus.chen.000102@quillpost.example";

  describe("Declarative Trait Mapping & Defaults", () => {
    it("maps custom trait values via declared collection options", () => {
      const longHair = AvatarGenerator.Generate({
        seed: femaleSeed,
        style: "toon-head",
        trait: "Female",
        traits: TOON_TRAITS,
        format: "svg",
      });
      const shortHair = AvatarGenerator.Generate({
        seed: femaleSeed,
        style: "toon-head",
        trait: "Male",
        traits: TOON_TRAITS,
        format: "svg",
      });

      expect(longHair).not.toBe(shortHair);
    });

    it("falls back to declared defaultTrait options when trait is null, undefined, or unmapped", () => {
      const fromNull = AvatarGenerator.Generate({
        seed: femaleSeed,
        style: "toon-head",
        trait: undefined,
        defaultTrait: "Female",
        traits: TOON_TRAITS,
        format: "svg",
      });
      const fromKey = AvatarGenerator.Generate({
        seed: femaleSeed,
        style: "toon-head",
        trait: "Female",
        traits: TOON_TRAITS,
        format: "svg",
      });

      expect(fromNull).toBe(fromKey);
    });

    it("defaults to offline base64 format when no format is specified", () => {
      const defaultOutput = AvatarGenerator.Generate({ seed: femaleSeed, style: "toon-head" });
      expect(defaultOutput.startsWith("data:image/svg+xml;base64,")).toBe(true);
    });

    it("rejects compact-svg at the schema and at Generate/BuildUrl", () => {
      expect(() => AvatarConfigSchema.parse({ style: "compact-svg" })).toThrow();
      expect(() =>
        AvatarGenerator.Generate({ seed: femaleSeed, style: "compact-svg" as DiceBearStyle }),
      ).toThrow(/not an offline DiceBear collection/);
      expect(() =>
        AvatarGenerator.BuildUrl({ seed: femaleSeed, style: "adventurer" as DiceBearStyle }),
      ).toThrow(/not an offline DiceBear collection/);
    });

    it("rejects invalid collection option values against schema", () => {
      expect(() => AvatarGenerator.ValidateStyleOptions("micah", { hair: ["long"] })).toThrow(
        /invalid value 'long'/,
      );
      expect(() => AvatarGenerator.ValidateStyleOptions("lorelei", { hair: ["short"] })).toThrow(
        /invalid value 'short'/,
      );
      expect(() => AvatarGenerator.ValidateStyleOptions("toon-head", { clothes: ["tuxedo"] })).toThrow(
        /invalid value 'tuxedo'/,
      );
    });

    it("throws when maxLength is exceeded", () => {
      expect(() =>
        AvatarGenerator.Generate({ seed: femaleSeed, style: "toon-head", maxLength: 10 }),
      ).toThrow(/exceeds maxLength 10/);
    });
  });

  describe("URL Mode (DiceBear API with Trait Sets)", () => {
    it("generates deterministic URL with Female trait options", () => {
      const url1 = AvatarGenerator.BuildUrl({
        seed: femaleSeed,
        trait: "Female",
        traits: TOON_TRAITS,
        style: "toon-head",
      });
      const url2 = AvatarGenerator.BuildUrl({
        seed: femaleSeed,
        trait: "Female",
        traits: TOON_TRAITS,
        style: "toon-head",
      });

      expect(url1).toBe(url2);
      expect(url1).toContain("https://api.dicebear.com/9.x/toon-head/svg");
      expect(url1).toContain("seed=elena.rodriguez.000101%40lakemail.example");
      expect(url1).toContain("rearHairProbability=100");
      expect(url1).toContain("beardProbability=0");
    });

    it("generates deterministic URL with Male trait options", () => {
      const url = AvatarGenerator.BuildUrl({
        seed: maleSeed,
        trait: "Male",
        traits: TOON_TRAITS,
        style: "toon-head",
      });

      expect(url).toContain("https://api.dicebear.com/9.x/toon-head/svg");
      expect(url).toContain("rearHairProbability=0");
      expect(url).toContain("beardProbability=40");
    });
  });

  describe("DiceBear SVG mode", () => {
    it("generates valid, deterministic SVG vectors", () => {
      const svg1 = AvatarGenerator.Generate({
        seed: femaleSeed,
        style: "toon-head",
        trait: "Female",
        traits: TOON_TRAITS,
        format: "svg",
      });
      const svg2 = AvatarGenerator.Generate({
        seed: femaleSeed,
        style: "toon-head",
        trait: "Female",
        traits: TOON_TRAITS,
        format: "svg",
      });

      expect(svg1).toBe(svg2);
      expect(svg1.startsWith("<svg")).toBe(true);
      expect(svg1.includes("</svg>")).toBe(true);
    });

    it("produces distinct SVG structures for Female vs Male traits", () => {
      const longSvg = AvatarGenerator.Generate({
        seed: femaleSeed,
        style: "toon-head",
        trait: "Female",
        traits: TOON_TRAITS,
        format: "svg",
      });
      const shortSvg = AvatarGenerator.Generate({
        seed: femaleSeed,
        style: "toon-head",
        trait: "Male",
        traits: TOON_TRAITS,
        format: "svg",
      });

      expect(longSvg).not.toBe(shortSvg);
    });

    it("encodes into a base64 data URI", () => {
      const femaleUri = AvatarGenerator.Generate({
        seed: femaleSeed,
        trait: "Female",
        traits: TOON_TRAITS,
        format: "base64",
        style: "toon-head",
      });
      const maleUri = AvatarGenerator.Generate({
        seed: maleSeed,
        trait: "Male",
        traits: TOON_TRAITS,
        format: "base64",
        style: "toon-head",
      });

      expect(femaleUri.startsWith("data:image/svg+xml;base64,")).toBe(true);
      expect(maleUri.startsWith("data:image/svg+xml;base64,")).toBe(true);
      expect(femaleUri).not.toBe(maleUri);
      expect(femaleUri.length).toBeGreaterThan(100);
    });

    it("pins a checksum per style so skipping svgo fails", () => {
      const pins: Record<DiceBearStyle, string> = {
        "toon-head": "bce206ed2ae9e672fb352fb4af8a7a4ad073841f",
        micah: "6af3cc5a19c34e9d04a40b5d4795d62a868b8824",
        lorelei: "17324e6e1d6f86f9f9a5f1621d1dcf999e1fa90b",
      };
      const got: Partial<Record<DiceBearStyle, string>> = {};
      for (const style of Object.keys(pins) as DiceBearStyle[]) {
        const svg = AvatarGenerator.Generate({
          seed: femaleSeed,
          style,
          trait: "Female",
          traits: STYLE_TRAITS[style],
          format: "svg",
        });
        const sha = createHash("sha1").update(svg).digest("hex");
        expect(svg.length, `${style} empty svg`).toBeGreaterThan(200);
        got[style] = sha;
      }
      expect(got).toEqual(pins);
    });

    it("renders 3,058 cheese Person.IDs fully distinct for every enum style", { timeout: 120_000 }, () => {
      const people: { id: string; gender?: string | null }[] = JSON.parse(readFileSync(cheesePersonIdsPath, "utf8"));
      expect(people.length).toBe(3058);
      for (const style of ["toon-head", "micah", "lorelei"] as DiceBearStyle[]) {
        const seedOnly = people.map((p) =>
          AvatarGenerator.Generate({ seed: p.id, style, format: "svg" }),
        );
        expect(new Set(seedOnly).size, `${style} seed-only`).toBe(3058);
        const mapped = people.map((p) =>
          AvatarGenerator.Generate({
            seed: p.id,
            style,
            trait: p.gender ?? undefined,
            traits: STYLE_TRAITS[style],
            format: "svg",
          }),
        );
        expect(new Set(mapped).size, `${style} mapped`).toBe(3058);
        expect(mapped.every((s) => s.length > 200), `${style} empty`).toBe(true);
      }
    });
  });
});

describe("LogoGenerator (Loom Deterministic Organization Logo Generation)", () => {
  const org1 = "Plumgate Farm";
  const org2 = "Beauchamp Farmstead Creamery";

  it("generates valid, deterministic SVG vector logos", () => {
    const svg1 = LogoGenerator.BuildSvg({ name: org1 });
    const svg2 = LogoGenerator.BuildSvg({ name: org1 });

    expect(svg1).toBe(svg2);
    expect(svg1.startsWith("<svg")).toBe(true);
    expect(svg1.endsWith("</svg>")).toBe(true);
    expect(svg1).toContain("PF");
  });

  it("extracts clean initials from organization names", () => {
    const svg = LogoGenerator.BuildSvg({ name: org2 });
    expect(svg).toContain("BF");
  });

  it("encodes into base64 data URI strictly under 1000 characters for SQL NVARCHAR(1000) safety", () => {
    const uri1 = LogoGenerator.Generate({ name: org1, format: "base64" });
    const uri2 = LogoGenerator.Generate({ name: org2, format: "base64" });

    expect(uri1.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(uri2.startsWith("data:image/svg+xml;base64,")).toBe(true);

    expect(uri1.length).toBeLessThan(1000);
    expect(uri2.length).toBeLessThan(1000);
    expect(uri1.length).toBeGreaterThan(100);
    expect(uri2.length).toBeGreaterThan(100);
  });

  it("defaults LogoConfigSchema.seedField to ID", () => {
    expect(LogoConfigSchema.parse({}).seedField).toBe("ID");
  });

  it("produces 641 distinct images for the 641 More Cheese organizations when seeded by ID", () => {
    const orgs: { id: string; name: string }[] = JSON.parse(readFileSync(moreCheeseOrgsPath, "utf8"));
    expect(orgs.length).toBe(641);

    const images = orgs.map((org) =>
      LogoGenerator.Generate({ name: org.name, seed: org.id, format: "base64" }),
    );
    const unique = new Set(images);
    expect(unique.size).toBe(641);

    for (const img of images) {
      expect(img.startsWith("data:image/svg+xml;base64,")).toBe(true);
      expect(img.length).toBeLessThan(1000);
      expect(img.length).toBeGreaterThan(100);
    }

    const orchardmere = orgs.filter((org) => org.name === "Orchardmere Cheese & Provisions");
    expect(orchardmere.length).toBe(2);
    expect(orchardmere[0]!.id).not.toBe(orchardmere[1]!.id);
    const a = LogoGenerator.Generate({ name: orchardmere[0]!.name, seed: orchardmere[0]!.id });
    const b = LogoGenerator.Generate({ name: orchardmere[1]!.name, seed: orchardmere[1]!.id });
    expect(a).not.toBe(b);
  });
});

describe("IdentityService.GenderFromName", () => {
  it("maps catalog names and returns Unknown otherwise", () => {
    expect(IdentityService.GenderFromName("Elena")).toBe("Female");
    expect(IdentityService.GenderFromName("Marcus")).toBe("Male");
    expect(IdentityService.GenderFromName("Xyzzy")).toBe("Unknown");
  });
});

describe("Generated uniqueness and name-gender gates", () => {
  it("fails uniqueness when two records share an avatar/logo field (automatic, no flag)", () => {
    const domain = sampleDomain({
      ID: { name: "ID", type: "uuid" },
      LogoURL: { name: "LogoURL", type: "string", logo: {} },
    });
    const v = new Validator();
    const fail = v.Validate(domain, {
      Sample: [
        { ID: "1", LogoURL: "same" },
        { ID: "2", LogoURL: "same" },
      ],
    });
    const gate = fail.gates.find((g) => g.name.startsWith("Generated uniqueness"));
    expect(gate?.passed).toBe(false);
    const pass = v.Validate(domain, {
      Sample: [
        { ID: "1", LogoURL: "a" },
        { ID: "2", LogoURL: "b" },
      ],
    });
    expect(pass.gates.find((g) => g.name.startsWith("Generated uniqueness"))?.passed).toBe(true);
  });

  it("fails name-gender when Gender disagrees with GenderFromName", () => {
    const domain = sampleDomain({
      ID: { name: "ID", type: "uuid" },
      FirstName: { name: "FirstName", type: "string" },
      Gender: { name: "Gender", type: "string" },
    });
    const v = new Validator();
    const fail = v.Validate(domain, {
      Sample: [{ ID: "1", FirstName: "Elena", Gender: "Male" }],
    });
    const g = fail.gates.find((x) => x.name.startsWith("Name-Gender"));
    expect(g?.passed).toBe(false);
    expect(g?.populationCount).toBe(1);
    expect(g?.message).toMatch(/0 unclassified/);
    const pass = v.Validate(domain, {
      Sample: [{ ID: "1", FirstName: "Elena", Gender: "Female" }],
    });
    expect(pass.gates.find((x) => x.name.startsWith("Name-Gender"))?.passed).toBe(true);
  });

  it("reports unclassified names separately from mismatches", () => {
    const domain = sampleDomain({
      ID: { name: "ID", type: "uuid" },
      FirstName: { name: "FirstName", type: "string" },
      Gender: { name: "Gender", type: "string" },
    });
    const v = new Validator();
    const report = v.Validate(domain, {
      Sample: [{ ID: "1", FirstName: "Xyzzy", Gender: "Male" }],
    });
    const g = report.gates.find((x) => x.name.startsWith("Name-Gender"));
    expect(g?.passed).toBe(true);
    expect(g?.populationCount).toBe(0);
    expect(g?.message).toMatch(/1 unclassified/);
  });
});

describe("applyFieldGenerators", () => {
  it("is idempotent", () => {
    const domain = sampleDomain({
      ID: { name: "ID", type: "uuid" },
      Gender: { name: "Gender", type: "string" },
      PhotoURL: {
        name: "PhotoURL",
        type: "string",
        avatar: { style: "toon-head", format: "svg", seedField: "ID", traitField: "Gender", traits: TOON_TRAITS },
      },
    });
    const data = { Sample: [{ ID: "ccfa1913-af56-545a-b63a-3916ffa4318b", Gender: "Female" }] };
    const once = applyFieldGenerators(domain, data);
    const twice = applyFieldGenerators(domain, once);
    expect(twice).toEqual(once);
    expect(once.Sample?.[0]?.PhotoURL).toEqual(twice.Sample?.[0]?.PhotoURL);
  });
});
