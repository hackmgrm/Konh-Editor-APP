/**
 * Themes the agent wrote, as opposed to the presets that ship in theme.ts.
 *
 * Each one is a JSON file in the app config directory (see themes.rs), and the
 * shape it holds is deliberately *not* a whole Theme: it names a `base` preset
 * and overrides the parts it cares about. That is what makes the format worth
 * handing to a CLI at all — a full Theme is ninety-odd fields, and asking for
 * all of them back is asking for ninety chances to get one wrong. A theme with
 * a different personality is usually twenty lines.
 *
 * Everything read here is treated as untrusted input, even though it came from
 * the user's own machine: these values end up inside HTML style attributes, and
 * an agent that misunderstands the format should produce a theme that looks
 * wrong, never a draft that pastes broken markup into WeChat. So the merge runs
 * off a whitelist of known fields, and every value is a scalar that has been
 * through `clean`.
 */

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getTheme, themes, type Theme } from '../theme';
import { THEME_GUIDE } from '../themeGuide';

/** Where the agent works, and the file it should read first */
export interface ThemePaths {
  dir: string;
  guide: string;
}

type Dict = Record<string, unknown>;

/**
 * What a field may hold: a CSS value, a flag, or one of a fixed set of words.
 *
 * The structural options are the ones that need a set: a misspelt colour is a
 * theme that looks wrong, but a misspelt `decor` would reach the renderer as
 * an unknown word and silently draw nothing at all.
 */
type Kind = 'css' | 'bool' | readonly string[];

const DECORS = [
  'none',
  'underline',
  'band',
  'accent-bar',
  'rule',
  'left-bar',
  'boxed',
  'marker',
  'numbered',
  'center-rule',
  'highlight',
] as const;

/** Object-valued fields, each with the keys it is allowed to carry */
const GROUPS: Record<string, Record<string, Kind>> = {
  body: {
    font: 'css',
    fontSize: 'css',
    lineHeight: 'css',
    color: 'css',
    bg: 'css',
    indent: 'bool',
    align: ['left', 'justify'],
    letterSpacing: 'css',
  },
  heading: {
    font: 'css',
    fontWeight: 'css',
    color: 'css',
    lineHeight: 'css',
    letterSpacing: 'css',
    marginTop: 'css',
    marginBottom: 'css',
    decor: DECORS,
    markerGlyph: 'css',
    align: ['left', 'center'],
  },
  headingSizes: { h1: 'css', h2: 'css', h3: 'css', h4: 'css', h5: 'css', h6: 'css' },
  quote: {
    background: 'css',
    color: 'css',
    borderLeft: 'css',
    borderRadius: 'css',
    padding: 'css',
    margin: 'css',
    fontStyle: 'css',
    bigMark: 'bool',
    style: ['bar', 'card', 'bracket', 'pull'],
    markGlyph: 'css',
  },
  callout: {
    background: 'css',
    color: 'css',
    borderLeft: 'css',
    borderRadius: 'css',
    padding: 'css',
    margin: 'css',
    badgeBg: 'css',
    badgeColor: 'css',
  },
  code: {
    background: 'css',
    color: 'css',
    borderRadius: 'css',
    padding: 'css',
    fontSize: 'css',
  },
  codeBlock: {
    background: 'css',
    color: 'css',
    borderRadius: 'css',
    padding: 'css',
    fontSize: 'css',
    lineHeight: 'css',
    chrome: ['none', 'dots', 'lang'],
  },
  link: { color: 'css', textDecoration: 'css', underline: 'css' },
  list: {
    bullet: 'css',
    bulletColor: 'css',
    ordered: ['plain', 'accent', 'pill'],
    taskGlyphs: 'css',
    taskChecked: 'css',
    taskUnchecked: 'css',
  },
  table: {
    borderColor: 'css',
    headBg: 'css',
    headColor: 'css',
    fontSize: 'css',
    cellPadding: 'css',
    style: ['grid', 'minimal', 'striped', 'rails'],
    stripeBg: 'css',
  },
  hr: {
    color: 'css',
    margin: 'css',
    style: ['line', 'dashed', 'dotted', 'double', 'glyph', 'fade'],
    glyph: 'css',
    width: 'css',
  },
  img: { borderRadius: 'css', margin: 'css', caption: 'bool', frame: 'css' },
  mark: { background: 'css', color: 'css', borderRadius: 'css', padding: 'css', underline: 'bool', borderColor: 'css' },
  footnote: {
    refColor: 'css',
    blockBorder: 'css',
    textColor: 'css',
    numColor: 'css',
    textSize: 'css',
  },
  components: {
    frontMatter: 'bool',
    cardBg: 'css',
    ink: 'css',
    border: 'css',
    sub: 'css',
    weak: 'css',
    olive: 'css',
  },
};

/**
 * Keys a file may clear with `null` — the optional ones, which the renderer
 * has a default for. That is how a theme takes away something its base has
 * (the base's own bullets, say). A required key cleared would reach the
 * renderer as `undefined` and print that word into a style attribute, so for
 * those `null` is simply ignored.
 */
const OPTIONAL: Record<string, readonly string[]> = {
  body: ['bg', 'indent', 'align', 'letterSpacing'],
  heading: ['letterSpacing', 'decor', 'markerGlyph', 'align'],
  quote: ['fontStyle', 'bigMark', 'style', 'markGlyph'],
  callout: ['badgeBg', 'badgeColor'],
  codeBlock: ['chrome'],
  list: ['bullet', 'bulletColor', 'ordered', 'taskGlyphs', 'taskChecked', 'taskUnchecked'],
  table: ['style', 'stripeBg'],
  hr: ['style', 'glyph', 'width'],
  img: ['caption', 'frame'],
  link: ['underline'],
};
const OPTIONAL_SCALARS = ['accentSoft', 'accentBright', 'strongWeight'];

/** Groups that additionally accept a free `extra` map of CSS declarations */
const WITH_EXTRA = ['quote', 'callout', 'code', 'codeBlock'];

/** Scalar top-level fields */
const SCALARS = [
  'mono',
  'accent',
  'accentSoft',
  'accentBright',
  'pMargin',
  'listPaddingLeft',
  'listItemMargin',
  'strongColor',
  'strongWeight',
  'delColor',
];

/**
 * A style value fit to sit inside a `style="…"` attribute.
 *
 * `<`, `>` and `"` are the three characters that could end the attribute (or
 * the tag) early, so a value carrying one is dropped rather than escaped —
 * there is no legitimate CSS value here that needs them, and a silently
 * mangled value is harder to explain than a field that did not take.
 */
function clean(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 240) return null;
  if (/[<>"]/.test(s)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(s)) return null;
  return s;
}

/** Pull the allowed keys out of a raw object, dropping anything unrecognized.
 *  A cleared optional key comes back as `null`, for the merge to delete */
function pick(raw: unknown, keys: Record<string, Kind>, optional: readonly string[] = []): Dict {
  if (!raw || typeof raw !== 'object') return {};
  const src = raw as Dict;
  const out: Dict = {};
  for (const [k, kind] of Object.entries(keys)) {
    if (!(k in src)) continue;
    if (src[k] === null) {
      if (optional.includes(k)) out[k] = null;
      continue;
    }
    if (kind === 'bool') {
      if (typeof src[k] === 'boolean') out[k] = src[k];
      continue;
    }
    if (kind !== 'css') {
      if (typeof src[k] === 'string' && kind.includes(src[k] as string)) out[k] = src[k];
      continue;
    }
    const value = clean(src[k]);
    if (value !== null) out[k] = value;
  }
  return out;
}

/** A free string → string map (`extra`, `codePalette`), cleaned value by value.
 *  With `clearable`, a `null` survives as a request to drop that key */
function freeMap(
  raw: unknown,
  keyOk: (k: string) => boolean,
  clearable = false,
): Record<string, string | null> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(raw as Dict)) {
    if (!keyOk(k)) continue;
    if (v === null) {
      if (clearable) out[k] = null;
      continue;
    }
    const value = clean(v);
    if (value !== null) out[k] = value;
  }
  return out;
}

const cssProp = (k: string) => /^[a-z-]{2,40}$/.test(k);
const hljsKey = (k: string) => /^[a-zA-Z_.-]{2,40}$/.test(k);
const idOk = (id: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id);

/**
 * Turn one file's JSON into a Theme, or null if it is not a theme at all.
 *
 * Missing means "inherit": every field the file does not mention is whatever
 * the base preset says, which is why a twenty-line file still renders a
 * complete article.
 */
export function parseTheme(raw: unknown): Theme | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Dict;

  const id = typeof src.id === 'string' ? src.id.trim() : '';
  const name = typeof src.name === 'string' ? src.name.trim() : '';
  if (!idOk(id) || !name || name.length > 24) return null;
  // A preset owns its id. Letting a file shadow one would mean a broken custom
  // theme could take a built-in theme away from the user
  if (themes.some((t) => t.id === id)) return null;

  const base = getTheme(typeof src.base === 'string' ? src.base : undefined);
  const out: Theme = { ...base, id, name, base: base.id };

  out.description =
    typeof src.description === 'string' && src.description.trim()
      ? src.description.trim().slice(0, 60)
      : base.description;
  out.appearance =
    src.appearance === 'dark' ? 'dark' : src.appearance === 'light' ? 'light' : base.appearance;
  if (src.codePaletteMode === 'light' || src.codePaletteMode === 'dark') {
    out.codePaletteMode = src.codePaletteMode;
  }

  for (const k of SCALARS) {
    if (src[k] === null && OPTIONAL_SCALARS.includes(k)) {
      delete (out as unknown as Dict)[k];
      continue;
    }
    const value = clean(src[k]);
    if (value !== null) (out as unknown as Dict)[k] = value;
  }

  for (const [group, keys] of Object.entries(GROUPS)) {
    const patch = pick(src[group], keys, OPTIONAL[group]);
    const extra = WITH_EXTRA.includes(group)
      ? freeMap((src[group] as Dict | undefined)?.extra, cssProp, true)
      : null;
    if (!Object.keys(patch).length && !(extra && Object.keys(extra).length)) continue;
    // `list` is the one group a preset may not have at all — a theme that
    // never asked for its own markers has no list object to inherit from
    const prev = ((base as unknown as Dict)[group] as Dict | undefined) ?? {};
    const merged: Dict = { ...prev, ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === null) delete merged[k];
    if (extra && Object.keys(extra).length) {
      const map: Dict = { ...(prev.extra as Dict), ...extra };
      for (const k of Object.keys(extra)) if (extra[k] === null) delete map[k];
      if (Object.keys(map).length) merged.extra = map;
      else delete merged.extra;
    }
    (out as unknown as Dict)[group] = merged;
  }

  const palette = freeMap(src.codePalette, hljsKey) as Record<string, string>;
  if (Object.keys(palette).length) out.codePalette = { ...base.codePalette, ...palette };

  return out;
}

/** Every custom theme on this machine. Never rejects — an unreadable directory
 *  simply means there are none */
export async function loadCustomThemes(): Promise<Theme[]> {
  let files: unknown[];
  try {
    files = await invoke<unknown[]>('themes_read');
  } catch (e) {
    console.warn('自定义主题读不了', e);
    return [];
  }
  const seen = new Set<string>();
  const out: Theme[] = [];
  for (const file of files) {
    const theme = parseTheme(file);
    if (!theme || seen.has(theme.id)) continue;
    seen.add(theme.id);
    out.push(theme);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

export function deleteCustomTheme(id: string): Promise<void> {
  return invoke('theme_delete', { id });
}

/**
 * A value typed into the theme studio, made fit for parseTheme.
 *
 * The one worth converting rather than dropping is `"`: it is what everyone
 * types around a font name ("PingFang SC"), and CSS reads `'` the same way.
 * Without this, the studio would show a font that the saved file then loses.
 */
export function cleanCss(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/"/g, "'").replace(/[<>\u0000-\u001f]/g, '').slice(0, 240);
}

/**
 * A whole Theme, written back as the file format: its base preset, plus only
 * what differs from it.
 *
 * Only the difference, for the same reason the agent is asked to write it
 * that way — the file stays readable, and a later change to a preset still
 * reaches the themes built on it. Something the base has and this theme took
 * away is written as `null` (see OPTIONAL).
 */
export function themeFile(th: Theme): Dict {
  const base = getTheme(th.base);
  const now = th as unknown as Dict;
  const was = base as unknown as Dict;
  const file: Dict = {
    id: th.id,
    name: th.name,
    description: th.description,
    base: base.id,
    appearance: th.appearance,
  };
  if (th.codePaletteMode !== base.codePaletteMode) file.codePaletteMode = th.codePaletteMode;
  for (const k of SCALARS) if (now[k] !== was[k]) file[k] = now[k] ?? null;

  for (const [group, keys] of Object.entries(GROUPS)) {
    const a = (now[group] as Dict | undefined) ?? {};
    const b = (was[group] as Dict | undefined) ?? {};
    const patch: Dict = {};
    for (const k of Object.keys(keys)) if (a[k] !== b[k]) patch[k] = a[k] ?? null;
    if (WITH_EXTRA.includes(group)) {
      const ea = (a.extra as Dict | undefined) ?? {};
      const eb = (b.extra as Dict | undefined) ?? {};
      const extra: Dict = {};
      for (const k of new Set([...Object.keys(ea), ...Object.keys(eb)])) {
        if (ea[k] !== eb[k]) extra[k] = ea[k] ?? null;
      }
      if (Object.keys(extra).length) patch.extra = extra;
    }
    if (Object.keys(patch).length) file[group] = patch;
  }

  const palette: Dict = {};
  for (const [k, v] of Object.entries(th.codePalette)) {
    if (base.codePalette[k] !== v) palette[k] = v;
  }
  if (Object.keys(palette).length) file.codePalette = palette;
  return file;
}

/**
 * Save a theme from the studio, and hand back the theme exactly as it will
 * load — through parseTheme, the same door the watcher reads it by — so the
 * caller can tell whether anything failed to make the trip.
 */
export async function saveCustomTheme(th: Theme): Promise<Theme> {
  const file = themeFile(th);
  const back = parseTheme(file);
  if (!back) throw new Error('主题名字或 id 不合法，存不了');
  await invoke('theme_write', { id: th.id, text: `${JSON.stringify(file, null, 2)}\n` });
  return back;
}

/** Put the current format guide on disk and report where the agent works */
export function ensureThemeGuide(): Promise<ThemePaths> {
  return invoke<ThemePaths>('themes_guide_write', { text: THEME_GUIDE });
}

/**
 * The custom themes, kept in step with the directory.
 *
 * The watcher is the point: the agent edits the file with its own tools while
 * the panel is open, and the preview should redraw as it goes — the same
 * arrangement the drafts already have.
 *
 * `null` until the first read comes back, and it means something: "no themes
 * yet" and "not read yet" look identical as an empty array, and a caller that
 * reacts to a theme *appearing* has to be able to tell those apart, or every
 * theme on disk looks brand new at startup.
 */
export function useCustomThemes(): Theme[] | null {
  const [list, setList] = useState<Theme[] | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void loadCustomThemes().then((next) => {
        if (alive) setList(next);
      });
    };
    refresh();
    const stop = listen('themes:change', refresh).catch(() => undefined);
    return () => {
      alive = false;
      void stop.then((fn) => fn?.());
    };
  }, []);

  return list;
}
