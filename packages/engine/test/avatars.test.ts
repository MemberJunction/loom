import { describe, it, expect } from "vitest";
import { AvatarGenerator } from "../src/avatars/AvatarGenerator.js";
import { LogoGenerator } from "../src/avatars/LogoGenerator.js";

describe("AvatarGenerator (Loom Deterministic Profile Image Generation)", () => {
  const femaleSeed = "elena.rodriguez.000101@lakemail.example";
  const maleSeed = "marcus.chen.000102@quillpost.example";

  describe("Declarative Trait Mapping & Defaults", () => {
    it("maps custom trait values via declared traits map", () => {
      const longHair = AvatarGenerator.BuildSvg({
        seed: femaleSeed,
        trait: "F",
        traits: { F: "long-hair", M: "short-hair" },
        defaultTrait: "neutral",
      });
      const shortHair = AvatarGenerator.BuildSvg({
        seed: femaleSeed,
        trait: "M",
        traits: { F: "long-hair", M: "short-hair" },
        defaultTrait: "neutral",
      });

      expect(longHair).not.toBe(shortHair);
    });

    it("falls back to declared defaultTrait when trait is null, undefined, or unmapped", () => {
      const neutralFromNull = AvatarGenerator.BuildSvg({
        seed: femaleSeed,
        trait: undefined,
        defaultTrait: "neutral",
      });
      const neutralExplicit = AvatarGenerator.BuildSvg({
        seed: femaleSeed,
        trait: "neutral",
      });

      expect(neutralFromNull).toBe(neutralExplicit);
    });

    it("defaults to offline base64 format when no format is specified", () => {
      const defaultOutput = AvatarGenerator.Generate({ seed: femaleSeed });
      expect(defaultOutput.startsWith("data:image/svg+xml;base64,")).toBe(true);
      expect(defaultOutput.length).toBeLessThan(1000);
    });
  });

  describe("URL Mode (DiceBear API with Trait Sets)", () => {
    it("generates deterministic URL with long-hair traits", () => {
      const url1 = AvatarGenerator.BuildUrl({ seed: femaleSeed, trait: "long-hair", style: "adventurer" });
      const url2 = AvatarGenerator.BuildUrl({ seed: femaleSeed, trait: "long-hair", style: "adventurer" });
      
      expect(url1).toBe(url2);
      expect(url1).toContain("https://api.dicebear.com/9.x/adventurer/svg");
      expect(url1).toContain("seed=elena.rodriguez.000101%40lakemail.example");
      expect(url1).toContain("hair=long01");
      expect(url1).not.toContain("mustache");
    });

    it("generates deterministic URL with short-hair traits", () => {
      const url = AvatarGenerator.BuildUrl({ seed: maleSeed, trait: "short-hair", style: "adventurer" });
      
      expect(url).toContain("https://api.dicebear.com/9.x/adventurer/svg");
      expect(url).toContain("hair=short01");
      expect(url).toContain("mustache");
    });

    it("supports avataaars style with trait-differentiated facialHairProbability", () => {
      const femaleUrl = AvatarGenerator.BuildUrl({ seed: femaleSeed, trait: "long-hair", style: "avataaars" });
      const maleUrl = AvatarGenerator.BuildUrl({ seed: maleSeed, trait: "short-hair", style: "avataaars" });

      expect(femaleUrl).toContain("facialHairProbability=0");
      expect(femaleUrl).toContain("top=longHair");
      expect(maleUrl).toContain("facialHairProbability=30");
      expect(maleUrl).toContain("top=shortHair");
    });
  });

  describe("Base64 / SVG Mode (Offline Vector Avatars)", () => {
    it("generates valid, deterministic SVG vectors", () => {
      const svg1 = AvatarGenerator.BuildSvg({ seed: femaleSeed, trait: "long-hair" });
      const svg2 = AvatarGenerator.BuildSvg({ seed: femaleSeed, trait: "long-hair" });

      expect(svg1).toBe(svg2);
      expect(svg1.startsWith("<svg")).toBe(true);
      expect(svg1.endsWith("</svg>")).toBe(true);
    });

    it("produces distinct SVG structures for long-hair vs short-hair traits", () => {
      const longSvg = AvatarGenerator.BuildSvg({ seed: femaleSeed, trait: "long-hair" });
      const shortSvg = AvatarGenerator.BuildSvg({ seed: femaleSeed, trait: "short-hair" });

      expect(longSvg).not.toBe(shortSvg);
    });

    it("encodes into base64 data URI strictly under 1000 characters for SQL NVARCHAR(1000) safety", () => {
      const femaleUri = AvatarGenerator.Generate({ seed: femaleSeed, trait: "long-hair", format: "base64" });
      const maleUri = AvatarGenerator.Generate({ seed: maleSeed, trait: "short-hair", format: "base64" });

      expect(femaleUri.startsWith("data:image/svg+xml;base64,")).toBe(true);
      expect(maleUri.startsWith("data:image/svg+xml;base64,")).toBe(true);

      // Must fit within database column NVARCHAR(1000) without truncation
      expect(femaleUri.length).toBeLessThan(1000);
      expect(maleUri.length).toBeLessThan(1000);
      expect(femaleUri.length).toBeGreaterThan(100);
      expect(maleUri.length).toBeGreaterThan(100);
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
});
