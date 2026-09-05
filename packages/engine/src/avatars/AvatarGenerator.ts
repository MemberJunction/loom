/**
 * AvatarGenerator — DiceBear collection adapter (loom #12 WP2).
 *
 * Offline SVG via @dicebear/core + a licensed collection, then svgo.
 * `compact-svg` / `adventurer` / etc. stay in the style enum so old
 * domain.json files fail loudly instead of silently mapping.
 */
import { createAvatar } from '@dicebear/core';
import * as toonHead from '@dicebear/toon-head';
import * as micah from '@dicebear/micah';
import * as lorelei from '@dicebear/lorelei';
import { optimize } from 'svgo';

export type DiceBearStyle = 'toon-head' | 'micah' | 'lorelei';

export interface AvatarOptions {
  seed: string;
  trait?: string;
  traits?: Record<string, string>;
  defaultTrait?: string;
  style?: string;
  format?: 'base64' | 'svg' | 'url';
  backgroundColor?: string;
  maxLength?: number;
}

const DICEBEAR_STYLES: Record<DiceBearStyle, unknown> = {
  'toon-head': toonHead,
  micah,
  lorelei,
};

const LEGACY_STYLES = new Set([
  'compact-svg',
  'adventurer',
  'lorelei-neutral',
  'pixel-art',
  'avataaars',
  'bottts',
  'fun-emoji',
]);

export class AvatarGenerator {
  public static ResolveTrait(options: AvatarOptions): string {
    const raw = (options.trait ?? '').trim();
    if (!raw) return options.defaultTrait ?? 'neutral';
    if (options.traits) {
      if (options.traits[raw]) return options.traits[raw];
      const lower = raw.toLowerCase();
      for (const [k, v] of Object.entries(options.traits)) {
        if (k.toLowerCase() === lower) return v;
      }
    }
    return options.defaultTrait ?? raw;
  }

  public static Generate(options: AvatarOptions): string {
    const format = options.format ?? 'base64';
    const style = options.style ?? 'toon-head';
    if (format === 'url') {
      return this.BuildUrl(options);
    }
    if (LEGACY_STYLES.has(style) || !(style in DICEBEAR_STYLES)) {
      throw new Error(
        `AvatarGenerator: style '${style}' is not an offline DiceBear collection. ` +
          `Use 'toon-head' (recommended), 'micah', or 'lorelei'. compact-svg was removed in loom #12 WP2.`,
      );
    }
    const svg = this.BuildDiceBearSvg(options, style as DiceBearStyle);
    const out = format === 'svg' ? svg : 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
    if (options.maxLength !== undefined && out.length > options.maxLength) {
      throw new Error(
        `AvatarGenerator: output length ${out.length} exceeds maxLength ${options.maxLength} (style=${style}, seed=${options.seed})`,
      );
    }
    return out;
  }

  public static BuildUrl(options: AvatarOptions): string {
    const style = options.style && options.style in DICEBEAR_STYLES ? options.style : 'toon-head';
    const params = new URLSearchParams();
    params.set('seed', options.seed);
    const trait = this.ResolveTrait(options).toLowerCase();
    this.applyTraitParams(params, style, trait);
    if (options.backgroundColor) {
      params.set('backgroundColor', options.backgroundColor.replace('#', ''));
    }
    return `https://api.dicebear.com/9.x/${style}/svg?${params.toString()}`;
  }

  private static BuildDiceBearSvg(options: AvatarOptions, style: DiceBearStyle): string {
    const collection = DICEBEAR_STYLES[style] as Parameters<typeof createAvatar>[0];
    const trait = this.ResolveTrait(options).toLowerCase();
    const avatar = createAvatar(collection, {
      seed: options.seed,
      ...this.diceBearOptions(style, trait, options.backgroundColor),
    });
    const raw = avatar.toString();
    const min = optimize(raw, { multipass: true, plugins: ['preset-default'] });
    return min.data;
  }

  private static diceBearOptions(
    style: string,
    trait: string,
    backgroundColor?: string,
  ): Record<string, unknown> {
    const isLong = trait === 'long-hair' || trait === 'variant-a';
    const isShort = trait === 'short-hair' || trait === 'variant-b';
    const opts: Record<string, unknown> = {};
    if (backgroundColor) {
      opts.backgroundColor = [backgroundColor.replace('#', '')];
    }
    if (style === 'toon-head') {
      if (isLong) {
        opts.rearHair = ['longStraight', 'longWavy', 'shoulderHigh'];
        opts.rearHairProbability = 100;
        opts.hairProbability = 0;
        opts.beardProbability = 0;
        opts.clothes = ['dress'];
      } else if (isShort) {
        opts.hair = ['sideComed', 'undercut', 'spiky', 'bun'];
        opts.hairProbability = 100;
        opts.rearHairProbability = 0;
        opts.beardProbability = 40;
        opts.clothes = ['shirt', 'tShirt', 'turtleNeck'];
      } else {
        opts.beardProbability = 10;
      }
    } else if (style === 'lorelei' || style === 'micah') {
      if (isLong) opts.hair = ['long'];
      else if (isShort) opts.hair = ['short'];
    }
    return opts;
  }

  private static applyTraitParams(params: URLSearchParams, style: string, trait: string): void {
    const isLong = trait === 'long-hair' || trait === 'variant-a';
    const isShort = trait === 'short-hair' || trait === 'variant-b';
    if (style === 'toon-head') {
      if (isLong) {
        params.set('rearHair', 'longStraight,longWavy,shoulderHigh');
        params.set('rearHairProbability', '100');
        params.set('hairProbability', '0');
        params.set('beardProbability', '0');
      } else if (isShort) {
        params.set('hair', 'sideComed,undercut,spiky,bun');
        params.set('hairProbability', '100');
        params.set('rearHairProbability', '0');
        params.set('beardProbability', '40');
      }
    } else {
      if (isLong) params.set('hair', 'long');
      else if (isShort) params.set('hair', 'short');
    }
  }
}
