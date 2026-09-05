/**
 * AvatarGenerator — DiceBear collection adapter (loom #12 WP2).
 *
 * Offline SVG via @dicebear/core + a licensed collection, then svgo.
 * Trait → collection options is declarative (domain.json `traits`).
 * Option keys and values are checked against `collection.schema`.
 */
import { createAvatar, type Style } from '@dicebear/core';
import * as toonHead from '@dicebear/toon-head';
import * as micah from '@dicebear/micah';
import * as lorelei from '@dicebear/lorelei';
import { optimize } from 'svgo';

export type DiceBearStyle = 'toon-head' | 'micah' | 'lorelei';

export type StyleOptionsMap = Record<string, Record<string, unknown>>;

export interface AvatarOptions {
  seed: string;
  trait?: string;
  traits?: StyleOptionsMap;
  defaultTrait?: string;
  style?: DiceBearStyle;
  format?: 'base64' | 'svg' | 'url';
  backgroundColor?: string;
  maxLength?: number;
}

const DICEBEAR_STYLES: Record<DiceBearStyle, Style<object>> = {
  'toon-head': toonHead as Style<object>,
  micah: micah as Style<object>,
  lorelei: lorelei as Style<object>,
};

const CORE_OPTION_KEYS = new Set([
  'seed',
  'flip',
  'rotate',
  'scale',
  'radius',
  'size',
  'backgroundColor',
  'backgroundType',
  'backgroundRotation',
  'translateX',
  'translateY',
  'clip',
  'randomizeIds',
]);

export class AvatarGenerator {
  public static IsStyle(value: string | undefined): value is DiceBearStyle {
    return value === 'toon-head' || value === 'micah' || value === 'lorelei';
  }

  public static Collection(style: DiceBearStyle): Style<object> {
    return DICEBEAR_STYLES[style];
  }

  public static ResolveStyleOptions(options: AvatarOptions): Record<string, unknown> {
    const traits = options.traits;
    if (!traits) return {};
    const raw = (options.trait ?? '').trim();
    if (raw) {
      if (traits[raw]) return traits[raw]!;
      const lower = raw.toLowerCase();
      for (const [k, v] of Object.entries(traits)) {
        if (k.toLowerCase() === lower) return v;
      }
    }
    const fallback = (options.defaultTrait ?? '').trim();
    if (fallback && traits[fallback]) return traits[fallback]!;
    return {};
  }

  public static ValidateStyleOptions(style: DiceBearStyle, styleOptions: Record<string, unknown>): void {
    const schema = DICEBEAR_STYLES[style].schema as
      | { properties?: Record<string, { type?: string; items?: { enum?: string[] }; enum?: string[]; minimum?: number; maximum?: number }> }
      | undefined;
    const props = schema?.properties ?? {};
    for (const [key, value] of Object.entries(styleOptions)) {
      if (CORE_OPTION_KEYS.has(key)) continue;
      const prop = props[key];
      if (!prop) {
        throw new Error(`AvatarGenerator: unknown option '${key}' for style '${style}'`);
      }
      if (Array.isArray(value)) {
        const allowed = prop.items?.enum;
        if (allowed) {
          for (const entry of value) {
            if (!allowed.includes(String(entry))) {
              throw new Error(
                `AvatarGenerator: invalid value '${entry}' for '${style}.${key}' (allowed: ${allowed.join(', ')})`,
              );
            }
          }
        }
      } else if (typeof value === 'string' && prop.enum && !prop.enum.includes(value)) {
        throw new Error(
          `AvatarGenerator: invalid value '${value}' for '${style}.${key}' (allowed: ${prop.enum.join(', ')})`,
        );
      } else if (typeof value === 'number' && prop.type === 'integer') {
        if (prop.minimum !== undefined && value < prop.minimum) {
          throw new Error(`AvatarGenerator: ${style}.${key}=${value} below minimum ${prop.minimum}`);
        }
        if (prop.maximum !== undefined && value > prop.maximum) {
          throw new Error(`AvatarGenerator: ${style}.${key}=${value} above maximum ${prop.maximum}`);
        }
      }
    }
  }

  public static Generate(options: AvatarOptions): string {
    const format = options.format ?? 'base64';
    const style = options.style ?? 'toon-head';
    if (!this.IsStyle(style)) {
      throw new Error(
        `AvatarGenerator: style '${String(style)}' is not an offline DiceBear collection. ` +
          `Use 'toon-head' (recommended), 'micah', or 'lorelei'.`,
      );
    }
    if (format === 'url') {
      return this.BuildUrl(options);
    }
    const styleOptions = this.ResolveStyleOptions(options);
    this.ValidateStyleOptions(style, styleOptions);
    const svg = this.BuildDiceBearSvg(options.seed, style, styleOptions, options.backgroundColor);
    const out = format === 'svg' ? svg : 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
    if (options.maxLength !== undefined && out.length > options.maxLength) {
      throw new Error(
        `AvatarGenerator: output length ${out.length} exceeds maxLength ${options.maxLength} (style=${style}, seed=${options.seed})`,
      );
    }
    return out;
  }

  public static BuildUrl(options: AvatarOptions): string {
    const style = options.style ?? 'toon-head';
    if (!this.IsStyle(style)) {
      throw new Error(
        `AvatarGenerator: style '${String(style)}' is not an offline DiceBear collection. ` +
          `Use 'toon-head' (recommended), 'micah', or 'lorelei'.`,
      );
    }
    const styleOptions = this.ResolveStyleOptions(options);
    this.ValidateStyleOptions(style, styleOptions);
    const params = new URLSearchParams();
    params.set('seed', options.seed);
    if (options.backgroundColor) {
      params.set('backgroundColor', options.backgroundColor.replace('#', ''));
    }
    for (const [key, value] of Object.entries(styleOptions)) {
      if (Array.isArray(value)) params.set(key, value.map(String).join(','));
      else if (value !== undefined && value !== null) params.set(key, String(value));
    }
    return `https://api.dicebear.com/9.x/${style}/svg?${params.toString()}`;
  }

  private static BuildDiceBearSvg(
    seed: string,
    style: DiceBearStyle,
    styleOptions: Record<string, unknown>,
    backgroundColor?: string,
  ): string {
    const collection = DICEBEAR_STYLES[style];
    const opts: Record<string, unknown> = { seed, ...styleOptions };
    if (backgroundColor) {
      opts.backgroundColor = [backgroundColor.replace('#', '')];
    }
    const avatar = createAvatar(collection, opts);
    const raw = avatar.toString();
    const min = optimize(raw, { multipass: true, plugins: ['preset-default'] });
    return min.data;
  }
}
