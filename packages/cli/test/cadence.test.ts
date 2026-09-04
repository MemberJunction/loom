import { describe, it, expect } from "vitest";
import { advanceDateByCycle } from "../src/commands/accumulate.js";
import { ProjectManifestSchema } from "@memberjunction/loom-contracts";

describe("L10-6 Cadence First-Class & Calendar-Correct Month Advance", () => {
  describe("advanceDateByCycle", () => {
    it("advances days correctly", () => {
      expect(advanceDateByCycle("2026-01-15", 1, "day")).toBe("2026-01-16");
      expect(advanceDateByCycle("2026-01-31", 1, "day")).toBe("2026-02-01");
      expect(advanceDateByCycle("2024-02-28", 1, "day")).toBe("2024-02-29"); // leap year
      expect(advanceDateByCycle("2024-02-29", 1, "day")).toBe("2024-03-01");
    });

    it("advances weeks correctly", () => {
      expect(advanceDateByCycle("2026-01-15", 1, "week")).toBe("2026-01-22");
      expect(advanceDateByCycle("2026-01-29", 1, "week")).toBe("2026-02-05");
      expect(advanceDateByCycle("2026-01-15", 4, "week")).toBe("2026-02-12");
    });

    it("advances months across 31-day boundaries without day-skipping or drifting", () => {
      // Jan 31 -> Feb 28 in non-leap year
      expect(advanceDateByCycle("2026-01-31", 1, "month")).toBe("2026-02-28");
      // Jan 31 -> Feb 29 in leap year 2024
      expect(advanceDateByCycle("2024-01-31", 1, "month")).toBe("2024-02-29");
      // March 31 -> April 30
      expect(advanceDateByCycle("2026-03-31", 1, "month")).toBe("2026-04-30");
      // May 31 -> June 30
      expect(advanceDateByCycle("2026-05-31", 1, "month")).toBe("2026-06-30");
      // August 31 -> September 30
      expect(advanceDateByCycle("2026-08-31", 1, "month")).toBe("2026-09-30");
      // October 31 -> November 30
      expect(advanceDateByCycle("2026-10-31", 1, "month")).toBe("2026-11-30");
    });

    it("advances multi-month steps correctly", () => {
      expect(advanceDateByCycle("2026-01-15", 3, "month")).toBe("2026-04-15");
      expect(advanceDateByCycle("2026-11-15", 2, "month")).toBe("2027-01-15"); // year boundary
      expect(advanceDateByCycle("2026-11-30", 3, "month")).toBe("2027-02-28"); // year + month-end
    });

    it("advances years correctly including leap year edge cases", () => {
      expect(advanceDateByCycle("2026-06-15", 1, "year")).toBe("2027-06-15");
      expect(advanceDateByCycle("2024-02-29", 1, "year")).toBe("2025-02-28"); // leap day to non-leap year
      expect(advanceDateByCycle("2024-02-29", 4, "year")).toBe("2028-02-29"); // leap day to next leap year
    });
  });

  describe("Manifest CycleUnit Schema Validation & Mutation", () => {
    it("accepts all 4 cycle units: day, week, month, year", () => {
      for (const unit of ["day", "week", "month", "year"]) {
        const manifest = {
          name: "test-manifest",
          version: "1.0.0",
          domain: "test",
          uuidNamespace: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          startCycle: 2021,
          releaseDate: "2026-09-02",
          cycleUnit: unit,
          output: { metadataDir: "./metadata" },
        };
        const parsed = ProjectManifestSchema.safeParse(manifest);
        expect(parsed.success).toBe(true);
      }
    });

    it("rejects invalid cycle units: fortnight, decade, invalid, hour", () => {
      for (const badUnit of ["fortnight", "decade", "invalid", "hour", "century"]) {
        const badManifest = {
          name: "test-manifest",
          version: "1.0.0",
          domain: "test",
          uuidNamespace: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          startCycle: 2021,
          releaseDate: "2026-09-02",
          cycleUnit: badUnit,
          output: { metadataDir: "./metadata" },
        };
        const parsed = ProjectManifestSchema.safeParse(badManifest);
        expect(parsed.success).toBe(false);
        if (!parsed.success) {
          const issue = parsed.error.issues.find((i) => i.path.includes("cycleUnit"));
          expect(issue).toBeDefined();
        }
      }
    });
  });
});
