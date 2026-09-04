import { describe, it, expect } from "vitest";
import { AvatarGenerator } from "../src/avatars/AvatarGenerator.js";

describe("AvatarGenerator (Loom Deterministic Profile Image Generation)", () => {
  const femaleSeed = "elena.rodriguez.000101@lakemail.example";
  const maleSeed = "marcus.chen.000102@quillpost.example";

  describe("URL Mode (DiceBear API with Gender Traits)", () => {
    it("generates deterministic URL with feminine traits for Female gender", () => {
      const url1 = AvatarGenerator.BuildUrl({ seed: femaleSeed, gender: "Female", style: "adventurer" });
      const url2 = AvatarGenerator.BuildUrl({ seed: femaleSeed, gender: "Female", style: "adventurer" });
      
      expect(url1).toBe(url2);
      expect(url1).toContain("https://api.dicebear.com/9.x/adventurer/svg");
      expect(url1).toContain("seed=elena.rodriguez.000101%40lakemail.example");
      expect(url1).toContain("hair=long01");
      expect(url1).not.toContain("mustache");
    });

    it("generates deterministic URL with masculine traits for Male gender", () => {
      const url = AvatarGenerator.BuildUrl({ seed: maleSeed, gender: "Male", style: "adventurer" });
      
      expect(url).toContain("https://api.dicebear.com/9.x/adventurer/svg");
      expect(url).toContain("hair=short01");
      expect(url).toContain("mustache");
    });

    it("supports avataaars style with gender-differentiated facialHairProbability", () => {
      const femaleUrl = AvatarGenerator.BuildUrl({ seed: femaleSeed, gender: "Female", style: "avataaars" });
      const maleUrl = AvatarGenerator.BuildUrl({ seed: maleSeed, gender: "Male", style: "avataaars" });

      expect(femaleUrl).toContain("facialHairProbability=0");
      expect(femaleUrl).toContain("top=longHair");
      expect(maleUrl).toContain("facialHairProbability=30");
      expect(maleUrl).toContain("top=shortHair");
    });
  });

  describe("Base64 / SVG Mode (Offline Vector Avatars)", () => {
    it("generates valid, deterministic SVG vectors", () => {
      const svg1 = AvatarGenerator.BuildSvg({ seed: femaleSeed, gender: "Female" });
      const svg2 = AvatarGenerator.BuildSvg({ seed: femaleSeed, gender: "Female" });

      expect(svg1).toBe(svg2);
      expect(svg1.startsWith("<svg")).toBe(true);
      expect(svg1.endsWith("</svg>")).toBe(true);
    });

    it("produces distinct SVG structures for Female vs Male", () => {
      const femaleSvg = AvatarGenerator.BuildSvg({ seed: femaleSeed, gender: "Female" });
      const maleSvg = AvatarGenerator.BuildSvg({ seed: femaleSeed, gender: "Male" });

      expect(femaleSvg).not.toBe(maleSvg);
    });

    it("encodes into base64 data URI strictly under 1000 characters for SQL NVARCHAR(1000) safety", () => {
      const femaleUri = AvatarGenerator.Generate({ seed: femaleSeed, gender: "Female", format: "base64" });
      const maleUri = AvatarGenerator.Generate({ seed: maleSeed, gender: "Male", format: "base64" });

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
