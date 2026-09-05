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

    // Derive 1-3 letter initials from significant words
    const words = String(options.name || '')
      .replace(/[,.]/g, '')
      .split(/\s+/)
      .filter((w) => !/^(inc|llc|co|corp|ltd|and|&|the|of|for)$/i.test(w));
    let initials = 'MC';
    const w0 = words[0];
    const w1 = words[1];
    const w2 = words[2];
    if (words.length >= 3 && w0 && w1 && w2 && w0[0] && w1[0] && w2[0]) {
      initials = (w0[0] + w1[0] + w2[0]).toUpperCase();
    } else if (words.length === 2 && w0 && w1 && w0[0] && w1[0]) {
      initials = (w0[0] + w1[0]).toUpperCase();
    } else if (words.length === 1 && w0 && w0.length >= 2) {
      initials = w0.slice(0, 2).toUpperCase();
    } else if (words.length === 1 && w0 && w0.length === 1) {
      initials = w0.toUpperCase();
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
      { bg: '#991b1b', ring: '#fecaca', text: '#ffffff' }, // Crimson / Champagne
      { bg: '#0f172a', ring: '#fbbf24', text: '#ffffff' }, // Midnight / Sunshine Gold
      { bg: '#2e1065', ring: '#f472b6', text: '#ffffff' }, // Royal Violet / Fuchsia
      { bg: '#14532d', ring: '#86efac', text: '#ffffff' }, // Forest / Light Green
      { bg: '#1e1b4b', ring: '#a5b4fc', text: '#ffffff' }, // Deep Blue / Periwinkle
      { bg: '#365314', ring: '#bef264', text: '#ffffff' }, // Lime Olive / Chartreuse
      { bg: '#701a75', ring: '#f5d0fe', text: '#ffffff' }, // Plum / Soft Lilac
      { bg: '#042f2e', ring: '#5eead4', text: '#ffffff' }, // Deep Sea / Aqua
      { bg: '#3b0764', ring: '#c084fc', text: '#ffffff' }, // Dark Grape / Purple
      { bg: '#451a03', ring: '#fdba74', text: '#ffffff' }, // Espresso / Apricot
      { bg: '#022c22', ring: '#6ee7b7', text: '#ffffff' }, // Dark Pine / Mint
      { bg: '#172554', ring: '#60a5fa', text: '#ffffff' }, // Cobalt / Ocean
      { bg: '#312e81', ring: '#818cf8', text: '#ffffff' }, // Midnight Indigo / Iris
      { bg: '#4a044e', ring: '#e879f9', text: '#ffffff' }, // Deep Magenta / Orchid
      { bg: '#0369a1', ring: '#bae6fd', text: '#ffffff' }, // Pacific / Cerulean
      { bg: '#b45309', ring: '#fef3c7', text: '#ffffff' }, // Ochre / Warm Cream
      { bg: '#064e3b', ring: '#6ee7b7', text: '#ffffff' }, // Jade / Seafoam
      { bg: '#881337', ring: '#fecdd3', text: '#ffffff' }, // Ruby / Blush
      { bg: '#0c4a6e', ring: '#7dd3fc', text: '#ffffff' }, // Aegean / Sky
      { bg: '#581c87', ring: '#d8b4fe', text: '#ffffff' }, // Amethyst / Lavender
      { bg: '#713f12', ring: '#fef08a', text: '#ffffff' }, // Toffee / Buttercup
      { bg: '#1f2937', ring: '#9ca3af', text: '#ffffff' }, // Charcoal / Silver
      { bg: '#854d0e', ring: '#fde047', text: '#ffffff' }, // Dijon / Yellow
      { bg: '#3f3f46', ring: '#a1a1aa', text: '#ffffff' }, // Zinc / Platinum
    ];
    const defaultPalette = { bg: '#1e3a8a', ring: '#93c5fd', text: '#ffffff' };
    const p = palettes[h % palettes.length] ?? defaultPalette;

    // Determine shape badge
    const shapeSetting = options.shape ?? 'auto';
    let shapeKind = 0;
    if (shapeSetting === 'squircle') shapeKind = 0;
    else if (shapeSetting === 'circle') shapeKind = 1;
    else if (shapeSetting === 'hexagon') shapeKind = 2;
    else shapeKind = (h >> 3) % 8;

    const ringDash = (h >> 12) % 2 === 0 ? '' : 'stroke-dasharray="4 2" ';
    let shapeSvg = '';
    if (shapeKind === 0) {
      // Rounded squircle with subtle inner frame
      shapeSvg =
        '<rect width="100" height="100" rx="22" fill="' +
        p.bg +
        '"/><rect x="6" y="6" width="88" height="88" rx="17" stroke="' +
        p.ring +
        '" stroke-width="2" ' +
        ringDash +
        'fill="none" opacity="0.4"/>';
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
    } else if (shapeKind === 2) {
      // Hexagonal shield badge
      shapeSvg =
        '<polygon points="50,4 92,25 92,75 50,96 8,75 8,25" fill="' +
        p.bg +
        '"/><polygon points="50,9 86,28 86,72 50,91 14,72 14,28" stroke="' +
        p.ring +
        '" stroke-width="2" ' +
        ringDash +
        'fill="none" opacity="0.5"/>';
    } else if (shapeKind === 3) {
      // Crest / Shield
      shapeSvg =
        '<path d="M50 5 C80 5 92 18 92 48 C92 74 68 88 50 95 C32 88 8 74 8 48 C8 18 20 5 50 5 Z" fill="' +
        p.bg +
        '"/><path d="M50 11 C75 11 86 22 86 48 C86 70 65 83 50 89 C35 83 14 70 14 48 C14 22 25 11 50 11 Z" stroke="' +
        p.ring +
        '" stroke-width="2" ' +
        ringDash +
        'fill="none" opacity="0.5"/>';
    } else if (shapeKind === 4) {
      // Octagonal chamfered badge
      shapeSvg =
        '<polygon points="30,6 70,6 94,30 94,70 70,94 30,94 6,70 6,30" fill="' +
        p.bg +
        '"/><polygon points="32,10 68,10 90,32 90,68 68,90 32,90 10,68 10,32" stroke="' +
        p.ring +
        '" stroke-width="2" ' +
        ringDash +
        'fill="none" opacity="0.5"/>';
    } else if (shapeKind === 5) {
      // Diamond badge
      shapeSvg =
        '<polygon points="50,5 95,50 50,95 5,50" fill="' +
        p.bg +
        '"/><polygon points="50,11 89,50 50,89 11,50" stroke="' +
        p.ring +
        '" stroke-width="2" ' +
        ringDash +
        'fill="none" opacity="0.5"/>';
    } else if (shapeKind === 6) {
      // Flat-top Hexagon
      shapeSvg =
        '<polygon points="25,6 75,6 96,50 75,94 25,94 4,50" fill="' +
        p.bg +
        '"/><polygon points="27,10 73,10 92,50 73,90 27,90 8,50" stroke="' +
        p.ring +
        '" stroke-width="2" ' +
        ringDash +
        'fill="none" opacity="0.5"/>';
    } else {
      // Soft rounded rectangle
      shapeSvg =
        '<rect x="6" y="6" width="88" height="88" rx="8" fill="' +
        p.bg +
        '"/><rect x="12" y="12" width="76" height="76" rx="4" stroke="' +
        p.ring +
        '" stroke-width="2" ' +
        ringDash +
        'fill="none" opacity="0.4"/>';
    }

    const decorKind = (h >> 6) % 5;
    let decorSvg = '';
    if (decorKind === 1) {
      decorSvg =
        '<line x1="32" y1="72" x2="68" y2="72" stroke="' +
        p.ring +
        '" stroke-width="2" stroke-linecap="round" opacity="0.8"/>';
    } else if (decorKind === 2) {
      decorSvg =
        '<circle cx="26" cy="50" r="2.5" fill="' +
        p.ring +
        '" opacity="0.7"/><circle cx="74" cy="50" r="2.5" fill="' +
        p.ring +
        '" opacity="0.7"/>';
    } else if (decorKind === 3) {
      decorSvg = '<circle cx="50" cy="24" r="2.5" fill="' + p.ring + '" opacity="0.8"/>';
    } else if (decorKind === 4) {
      decorSvg =
        '<line x1="36" y1="26" x2="64" y2="26" stroke="' +
        p.ring +
        '" stroke-width="1.5" stroke-dasharray="2 2" opacity="0.7"/>';
    }

    const fontFamily = (h >> 9) % 2 === 0 ? 'system-ui,-apple-system,sans-serif' : 'Georgia,serif';
    const letterSpacing = (h >> 11) % 2 === 0 ? '1' : '2';
    const fontWeight = (h >> 13) % 2 === 0 ? '700' : '800';
    const fontSize = initials.length > 2 ? 26 : 34;
    const textSvg =
      '<text x="50" y="56" font-family="' +
      fontFamily +
      '" font-size="' +
      fontSize +
      '" font-weight="' +
      fontWeight +
      '" fill="' +
      p.text +
      '" text-anchor="middle" dominant-baseline="central" letter-spacing="' +
      letterSpacing +
      '">' +
      initials +
      '</text>';

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' + shapeSvg + decorSvg + textSvg + '</svg>';
  }
}
