/**
 * AvatarGenerator.ts
 *
 * Deterministic avatar generation service for entity profile images.
 * Supports:
 *  - URL mode: Deterministic DiceBear v9 API URLs with gender-tailored traits (hair styles, facial features)
 *  - Base64 / SVG mode: Self-contained offline vector cartoon SVGs fitting within database VARCHAR constraints (<1000 chars)
 */

export interface AvatarOptions {
  seed: string;
  gender?: string;
  style?: "adventurer" | "lorelei" | "avataaars" | "bottts" | "fun-emoji" | "compact-svg";
  format?: "url" | "base64" | "svg";
  backgroundColor?: string;
}

export class AvatarGenerator {
  /**
   * Generates a deterministic avatar string based on format (URL, inline base64 SVG data URI, or raw SVG).
   */
  public static Generate(options: AvatarOptions): string {
    const format = options.format ?? "url";
    if (format === "url") {
      return this.BuildUrl(options);
    }
    const svg = this.BuildSvg(options);
    if (format === "svg") {
      return svg;
    }
    const base64 = Buffer.from(svg, "utf8").toString("base64");
    return "data:image/svg+xml;base64," + base64;
  }

  /**
   * Builds a deterministic DiceBear URL with gender-aware features.
   */
  public static BuildUrl(options: AvatarOptions): string {
    const style = (options.style === "compact-svg" || !options.style) ? "adventurer" : options.style;
    const params = new URLSearchParams();
    params.set("seed", options.seed);

    const gender = (options.gender ?? "").trim().toLowerCase();
    const isFemale = gender === "female" || gender === "f" || gender === "woman";
    const isMale = gender === "male" || gender === "m" || gender === "man";

    if (style === "adventurer") {
      if (isFemale) {
        params.set(
          "hair",
          "long01,long02,long03,long04,long05,long06,long07,long08,long09,long10,long11,long12,long13,long14,long15,long16,long17,long18,long19,long20"
        );
        params.set("features", "blush,freckles,birthmark");
        params.set("featuresProbability", "20");
      } else if (isMale) {
        params.set(
          "hair",
          "short01,short02,short03,short04,short05,short06,short07,short08,short09,short10,short11,short12,short13,short14,short15,short16"
        );
        params.set("features", "mustache,blush,freckles,birthmark");
        params.set("featuresProbability", "25");
      }
    } else if (style === "avataaars") {
      if (isFemale) {
        params.set("facialHairProbability", "0");
        params.set(
          "top",
          "longHair,straight01,straight02,curly,dreads01,dreads02,fro,frizzle,miaWallace,bob"
        );
      } else if (isMale) {
        params.set("facialHairProbability", "30");
        params.set(
          "top",
          "shortHair,shortFlat,shortRound,shortWaved,theCaesar,theCaesarAndSidePart,frizzle"
        );
      }
    }

    if (options.backgroundColor) {
      params.set("backgroundColor", options.backgroundColor.replace("#", ""));
    }

    return "https://api.dicebear.com/9.x/" + style + "/svg?" + params.toString();
  }

  /**
   * Builds an offline, lightweight deterministic cartoon vector SVG with gender differentiation.
   * Total raw length is ~450-570 bytes, base64 data URI length is ~620-780 chars (guaranteed <1000 chars).
   */
  public static BuildSvg(options: AvatarOptions): string {
    let hash = 2166136261;
    for (let i = 0; i < options.seed.length; i++) {
      hash ^= options.seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const h = Math.abs(hash);

    const gender = (options.gender ?? "").trim().toLowerCase();
    const isFemale = gender === "female" || gender === "f" || gender === "woman";
    const isMale = gender === "male" || gender === "m" || gender === "man";

    const bgColors = ["#e0f2fe", "#fef3c7", "#dcfce7", "#f3e8ff", "#ffe4e6"];
    const skinTones = ["#f8d9b8", "#f2c59f", "#d99d6d", "#bb7744", "#8a4b27"];
    const hairColors = ["#2c1810", "#4a3728", "#8b4513", "#d4af37", "#1a1a1a"];
    const shirtColors = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];

    const bg = options.backgroundColor ?? bgColors[h % bgColors.length];
    const skin = skinTones[(h >> 3) % skinTones.length];
    const hair = hairColors[(h >> 6) % hairColors.length];
    const shirt = shirtColors[(h >> 9) % shirtColors.length];

    let hairSvg = "";
    if (isFemale) {
      hairSvg =
        '<path d="M28 50C28 20 72 20 72 50C76 65 76 85 70 90C66 82 66 50 66 45C66 32 34 32 34 45C34 50 34 82 30 90C24 85 24 65 28 50Z" fill="' +
        hair +
        '"/><circle cx="50" cy="38" r="17" fill="' +
        hair +
        '"/>';
    } else if (isMale) {
      hairSvg = '<path d="M30 46C30 25 70 25 70 46C68 34 32 34 30 46Z" fill="' + hair + '"/>';
    } else {
      // Neutral: balanced medium cropped hair
      hairSvg = '<path d="M30 48C30 24 70 24 70 48C68 32 32 32 30 48Z" fill="' + hair + '"/>';
    }

    const mustacheSvg = isMale && (h % 3 === 0)
      ? '<path d="M44 68Q50 70 56 68Q50 66 44 68" fill="' + hair + '"/>'
      : "";

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="' + bg + '"/><path d="M25 100C25 80 75 80 75 100Z" fill="' + shirt + '"/><circle cx="50" cy="54" r="19" fill="' + skin + '"/><circle cx="43" cy="54" r="2"/><circle cx="57" cy="54" r="2"/><path d="M45 68Q50 72 55 68" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>' + hairSvg + mustacheSvg + '</svg>';
  }
}
