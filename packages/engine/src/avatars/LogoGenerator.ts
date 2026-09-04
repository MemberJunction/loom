/**
 * LogoGenerator.ts
 *
 * Deterministic vector emblem logo generation service for Organization profiles.
 * Supports:
 *  - Base64 / SVG mode: Self-contained offline vector monogram seals fitting within database NVARCHAR(1000) constraints (<800 chars)
 *  - Geometric badges: squircle, circular seal, hexagonal shield
 *  - Curated executive and artisanal brand color pairings
 */

export interface LogoOptions {
  name: string;
  seed?: string;
  format?: 'base64' | 'svg';
  shape?: 'auto' | 'squircle' | 'circle' | 'hexagon';
}

export class LogoGenerator {
  /**
   * Generates a deterministic organization logo string (inline base64 SVG data URI or raw SVG).
   */
  public static Generate(options: LogoOptions): string {
    const format = options.format ?? 'base64';
    const svg = this.BuildSvg(options);
    if (format === 'svg') {
      return svg;
    }
    const base64 = Buffer.from(svg, 'utf8').toString('base64');
    return 'data:image/svg+xml;base64,' + base64;
  }

  /**
   * Builds an offline, lightweight deterministic monogram emblem SVG badge.
   * Total raw length is ~400-500 bytes, base64 data URI length is ~580-720 chars (guaranteed <1000 chars).
   */
  public static BuildSvg(options: LogoOptions): string {
    const seed = String(options.seed ?? options.name ?? 'default');
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const h = Math.abs(hash);

    // Derive 1-2 letter initials from significant words
    const words = String(options.name || '')
      .replace(/[,.]/g, '')
      .split(/\s+/)
      .filter((w) => !/^(inc|llc|co|corp|ltd|and|&|the|of|for)$/i.test(w));
    const firstWord = words[0];
    const secondWord = words[1];
    let initials = 'MC';
    if (firstWord && secondWord && firstWord[0] && secondWord[0]) {
      initials = (firstWord[0] + secondWord[0]).toUpperCase();
    } else if (firstWord && firstWord.length >= 2) {
      initials = firstWord.slice(0, 2).toUpperCase();
    } else if (firstWord && firstWord.length === 1) {
      initials = firstWord.toUpperCase();
    }

    // Curated brand color pairings [background, accent ring, text]
    const palettes = [
      { bg: '#1e3a8a', ring: '#93c5fd', text: '#ffffff' }, // Navy / Sky Blue
      { bg: '#065f46', ring: '#a7f3d0', text: '#ffffff' }, // Emerald / Mint
      { bg: '#7c2d12', ring: '#fed7aa', text: '#ffffff' }, // Rust / Warm Amber
      { bg: '#4c1d95', ring: '#ddd6fe', text: '#ffffff' }, // Deep Indigo / Lavender
      { bg: '#134e4a', ring: '#99f6e4', text: '#ffffff' }, // Dark Teal / Cyan
      { bg: '#831843', ring: '#fbcfe8', text: '#ffffff' }, // Wine / Rose
      { bg: '#1e293b', ring: '#38bdf8', text: '#ffffff' }, // Slate / Light Blue
      { bg: '#78350f', ring: '#fde68a', text: '#ffffff' }, // Bronze / Gold
    ];
    const defaultPalette = { bg: '#1e3a8a', ring: '#93c5fd', text: '#ffffff' };
    const p = palettes[h % palettes.length] ?? defaultPalette;

    // Determine shape badge
    const shapeSetting = options.shape ?? 'auto';
    let shapeKind = 0;
    if (shapeSetting === 'squircle') shapeKind = 0;
    else if (shapeSetting === 'circle') shapeKind = 1;
    else if (shapeSetting === 'hexagon') shapeKind = 2;
    else shapeKind = (h >> 3) % 3;

    let shapeSvg = '';
    if (shapeKind === 0) {
      // Rounded squircle with subtle inner frame
      shapeSvg =
        '<rect width="100" height="100" rx="22" fill="' +
        p.bg +
        '"/><rect x="6" y="6" width="88" height="88" rx="17" stroke="' +
        p.ring +
        '" stroke-width="2" fill="none" opacity="0.4"/>';
    } else if (shapeKind === 1) {
      // Circular seal with concentric accent rings
      shapeSvg =
        '<circle cx="50" cy="50" r="48" fill="' +
        p.bg +
        '"/><circle cx="50" cy="50" r="41" stroke="' +
        p.ring +
        '" stroke-width="2" stroke-dasharray="6 3" fill="none" opacity="0.6"/><circle cx="50" cy="50" r="37" stroke="' +
        p.ring +
        '" stroke-width="1" fill="none" opacity="0.3"/>';
    } else {
      // Hexagonal shield badge
      shapeSvg =
        '<polygon points="50,4 92,25 92,75 50,96 8,75 8,25" fill="' +
        p.bg +
        '"/><polygon points="50,9 86,28 86,72 50,91 14,72 14,28" stroke="' +
        p.ring +
        '" stroke-width="2" fill="none" opacity="0.5"/>';
    }

    const fontSize = initials.length > 2 ? 28 : 34;
    const textSvg =
      '<text x="50" y="58" font-family="system-ui,-apple-system,sans-serif" font-size="' +
      fontSize +
      '" font-weight="700" fill="' +
      p.text +
      '" text-anchor="middle" dominant-baseline="central" letter-spacing="1">' +
      initials +
      '</text>';

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' + shapeSvg + textSvg + '</svg>';
  }
}
