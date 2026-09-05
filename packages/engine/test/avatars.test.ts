import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LogoConfigSchema } from "@memberjunction/loom-contracts";
import { AvatarGenerator } from "../src/avatars/AvatarGenerator.js";
import { LogoGenerator } from "../src/avatars/LogoGenerator.js";
import { IdentityService } from "../src/identity/index.js";
import { Validator } from "../src/validation/validator.js";

const moreCheeseOrgsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/more-cheese-organizations.json",
);

describe("AvatarGenerator (Loom Deterministic Profile Image Generation)", () => {
  const femaleSeed = "elena.rodriguez.000101@lakemail.example";
  const maleSeed = "marcus.chen.000102@quillpost.example";

  describe("Declarative Trait Mapping & Defaults", () => {
    it("maps custom trait values via declared traits map", () => {
      const longHair = AvatarGenerator.Generate({
        seed: femaleSeed,
        style: "toon-head",
        trait: "F",
        traits: { F: "long-hair", M: "short-hair" },
        defaultTrait: "neutral",
        format: "svg",
      });
      const shortHair = AvatarGenerator.Generate({
        seed: femaleSeed,
        style: "toon-head",
        trait: "M",
        traits: { F: "long-hair", M: "short-hair" },
        defaultTrait: "neutral",
        format: "svg",
      });

      expect(longHair).not.toBe(shortHair);
    });

    it("falls back to declared defaultTrait when trait is null, undefined, or unmapped", () => {
      const neutralFromNull = AvatarGenerator.Generate({
        seed: femaleSeed,
        style: "toon-head",
        trait: undefined,
        defaultTrait: "neutral",
        format: "svg",
      });
      const neutralExplicit = AvatarGenerator.Generate({
        seed: femaleSeed,
        style: "toon-head",
        trait: "neutral",
        format: "svg",
      });

      expect(neutralFromNull).toBe(neutralExplicit);
    });

    it("defaults to offline base64 format when no format is specified", () => {
      const defaultOutput = AvatarGenerator.Generate({ seed: femaleSeed, style: "toon-head" });
      expect(defaultOutput.startsWith("data:image/svg+xml;base64,")).toBe(true);
    });

    it("throws on compact-svg instead of silently mapping", () => {
      expect(() => AvatarGenerator.Generate({ seed: femaleSeed, style: "compact-svg" })).toThrow(
        /not an offline DiceBear collection/,
      );
    });

    it("throws when maxLength is exceeded", () => {
      expect(() =>
        AvatarGenerator.Generate({ seed: femaleSeed, style: "toon-head", maxLength: 10 }),
      ).toThrow(/exceeds maxLength 10/);
    });
  });

  describe("URL Mode (DiceBear API with Trait Sets)", () => {
    it("generates deterministic URL with long-hair traits", () => {
      const url1 = AvatarGenerator.BuildUrl({ seed: femaleSeed, trait: "long-hair", style: "toon-head" });
      const url2 = AvatarGenerator.BuildUrl({ seed: femaleSeed, trait: "long-hair", style: "toon-head" });

      expect(url1).toBe(url2);
      expect(url1).toContain("https://api.dicebear.com/9.x/toon-head/svg");
      expect(url1).toContain("seed=elena.rodriguez.000101%40lakemail.example");
      expect(url1).toContain("rearHair=");
      expect(url1).toContain("beardProbability=0");
    });

    it("generates deterministic URL with short-hair traits", () => {
      const url = AvatarGenerator.BuildUrl({ seed: maleSeed, trait: "short-hair", style: "toon-head" });

      expect(url).toContain("https://api.dicebear.com/9.x/toon-head/svg");
      expect(url).toContain("hair=");
      expect(url).toContain("beardProbability=40");
    });
  });

  describe("DiceBear SVG mode", () => {
    it("generates valid, deterministic SVG vectors", () => {
      const svg1 = AvatarGenerator.Generate({ seed: femaleSeed, style: "toon-head", trait: "long-hair", format: "svg" });
      const svg2 = AvatarGenerator.Generate({ seed: femaleSeed, style: "toon-head", trait: "long-hair", format: "svg" });

      expect(svg1).toBe(svg2);
      expect(svg1.startsWith("<svg")).toBe(true);
      expect(svg1.includes("</svg>")).toBe(true);
    });

    it("produces distinct SVG structures for long-hair vs short-hair traits", () => {
      const longSvg = AvatarGenerator.Generate({ seed: femaleSeed, style: "toon-head", trait: "long-hair", format: "svg" });
      const shortSvg = AvatarGenerator.Generate({ seed: femaleSeed, style: "toon-head", trait: "short-hair", format: "svg" });

      expect(longSvg).not.toBe(shortSvg);
    });

    it("encodes into a base64 data URI", () => {
      const femaleUri = AvatarGenerator.Generate({ seed: femaleSeed, trait: "long-hair", format: "base64", style: "toon-head" });
      const maleUri = AvatarGenerator.Generate({ seed: maleSeed, trait: "short-hair", format: "base64", style: "toon-head" });

      expect(femaleUri.startsWith("data:image/svg+xml;base64,")).toBe(true);
      expect(maleUri.startsWith("data:image/svg+xml;base64,")).toBe(true);
      expect(femaleUri).not.toBe(maleUri);
      expect(femaleUri.length).toBeGreaterThan(100);
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
  it("fails uniqueness when two records share a generated field", () => {
    const domain = {
      entities: {
        Org: {
          name: "Org",
          entityName: "Org",
          targetTable: "Org",
          schema: "dbo",
          pack: "p",
          businessKey: ["ID"],
          fields: {
            ID: { name: "ID", type: "uuid" as const, uniqueness: undefined },
            LogoURL: { name: "LogoURL", type: "string" as const, uniqueness: "generated" as const },
          },
          foreignKeys: {},
        },
      },
    } as any;
    const v = new Validator();
    const fail = v.Validate(domain, {
      Org: [
        { ID: "1", LogoURL: "same" },
        { ID: "2", LogoURL: "same" },
      ],
    });
    const gate = fail.gates.find((g) => g.name.startsWith("Generated uniqueness"));
    expect(gate?.passed).toBe(false);
    const pass = v.Validate(domain, {
      Org: [
        { ID: "1", LogoURL: "a" },
        { ID: "2", LogoURL: "b" },
      ],
    });
    expect(pass.gates.find((g) => g.name.startsWith("Generated uniqueness"))?.passed).toBe(true);
  });

  it("fails name-gender when Gender disagrees with GenderFromName", () => {
    const domain = {
      entities: {
        Person: {
          name: "Person",
          entityName: "Person",
          targetTable: "Person",
          schema: "dbo",
          pack: "p",
          businessKey: ["ID"],
          fields: {
            ID: { name: "ID", type: "uuid" as const },
            FirstName: { name: "FirstName", type: "string" as const },
            Gender: { name: "Gender", type: "string" as const },
          },
          foreignKeys: {},
        },
      },
    } as any;
    const v = new Validator();
    const fail = v.Validate(domain, {
      Person: [{ ID: "1", FirstName: "Elena", Gender: "Male" }],
    });
    expect(fail.gates.find((g) => g.name.startsWith("Name-Gender"))?.passed).toBe(false);
    const pass = v.Validate(domain, {
      Person: [{ ID: "1", FirstName: "Elena", Gender: "Female" }],
    });
    expect(pass.gates.find((g) => g.name.startsWith("Name-Gender"))?.passed).toBe(true);
  });
});
