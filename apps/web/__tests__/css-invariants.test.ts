import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.tsx') ? [p] : [];
  });
const sources = [...walk(join(__dirname, '..', 'app')), ...walk(join(__dirname, '..', 'components'))];
const tsx = sources.map((f) => readFileSync(f, 'utf8')).join('\n');

/** Body of a rule, e.g. block('.svc-card') -> "display: flex; ..." */
function block(selector: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[,}])\\s*${esc}\\s*\\{([^}]*)\\}`, 'm');
  return re.exec(css)?.[2] ?? null;
}

/** Declarations as a map, so assertions test VALUES rather than fight regexes. */
function decls(body: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (body ?? '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

describe('the bare button element must stay a reset', () => {
  const body = block('button');

  it('exists', () => expect(body).not.toBeNull());

  /**
   * These three assertions each encode a shipped bug.
   *
   * Styling `button` as the primary CTA meant every card-shaped control inherited
   * it: white text on white cards, bold body copy, and once inline-flex was added
   * so links could be buttons, stacked card content collapsed into a centred row.
   */
  it('does not set a foreground colour of its own', () => {
    const c = decls(body).color;
    expect(c === undefined || c === 'inherit', `button sets color: ${c}`).toBe(true);
  });

  it('does not force a flex layout on every button', () => {
    expect(decls(body).display ?? '').not.toMatch(/flex/);
  });

  it('does not paint a background', () => {
    const bg = decls(body).background;
    expect(bg === undefined || bg === 'none', `button sets background: ${bg}`).toBe(true);
  });
});

describe('card-shaped controls declare their own box', () => {
  // Each of these is rendered on a <button>, so it inherits nothing from the reset
  // and must state display, colour and text alignment itself.
  const CARDS = ['.svc-card', '.pick', '.daychip', '.slot', '.opt', '.city-pill'];

  it.each(CARDS)('%s sets display and colour', (sel) => {
    const body = block(sel);
    expect(body, `${sel} is missing from globals.css`).not.toBeNull();
    expect(body, `${sel} must set display`).toMatch(/display:/);
    expect(body, `${sel} must set color, or text is invisible on a white card`)
      .toMatch(/color:/);
  });
});

describe('the CTA look is opt-in', () => {
  it('.btn carries the orange treatment', () => {
    const d = decls(block('.btn'));
    expect(d.background).toBeTruthy();
    expect(d.color).toBeTruthy();
  });

  it('.btn works on an anchor as well as a button', () => {
    // Navigation must be a link styled as a button, never a button inside a link.
    expect(css).toMatch(/\.btn\b[^{]*\{[^}]*display:\s*inline-flex/);
  });
});

describe('no dead classes', () => {
  /**
   * Catches a class that was removed from CSS but left behind in markup - which is
   * how the admin refresh button silently became a solid orange CTA after `plain`
   * was deleted during the palette change.
   */
  const KNOWN_DYNAMIC = new Set(['on', 'done', 'skeleton-card', 'native', 'bn', 'contents']);

  it('every className token in the markup exists in the stylesheet', () => {
    const tokens = new Set<string>();
    for (const m of tsx.matchAll(/className="([^"{}]+)"/g)) {
      for (const t of m[1]!.split(/\s+/)) if (t) tokens.add(t);
    }
    const missing = [...tokens].filter((t) =>
      !KNOWN_DYNAMIC.has(t) && !new RegExp(`\\.${t}\\b`).test(css));
    expect(missing).toEqual([]);
  });
});

describe('nothing can be wider than the screen', () => {
  /**
   * `1fr` is shorthand for `minmax(auto, 1fr)`, and `min-width: auto` means the track
   * refuses to shrink below its content. A horizontally scrolling child - the 21-day
   * date strip, a wide table - then widens the whole grid and the page overflows the
   * viewport instead of scrolling inside its own box.
   */
  it('every multi-track grid uses minmax(0, …) rather than a bare fr', () => {
    const offenders: string[] = [];
    for (const m of css.matchAll(/grid-template-columns:\s*([^;]+);/g)) {
      const value = m[1]!.trim();
      if (value.includes('repeat(auto-fill') || value.includes('repeat(auto-fit')) continue;
      const tracks = value.split(/\s+/);
      if (tracks.length < 2) continue;                    // single column cannot overflow
      if (tracks.some((t) => /^[\d.]+fr$/.test(t))) offenders.push(value);
    }
    expect(offenders).toEqual([]);
  });

  it('horizontal scrollers are capped at their container width', () => {
    const strip = block('.daystrip');
    expect(strip).toMatch(/overflow-x:\s*auto/);
    expect(strip, '.daystrip must not be able to widen its parent').toMatch(/max-width:\s*100%/);
  });

  it('tables are wrapped in a scroll container, never left to stretch', () => {
    expect(block('.table-wrap')).toMatch(/overflow-x:\s*auto/);
    const tables = (tsx.match(/<table>/g) ?? []).length;
    // Whitespace-tolerant: the wrapper and the table are often on separate lines.
    const wrapped = (tsx.match(/table-wrap"[^>]*>\s*<table>/g) ?? []).length;
    expect(wrapped, 'every <table> needs a .table-wrap parent').toBe(tables);
  });

  it('media never overflows its container', () => {
    expect(css).toMatch(/img,\s*svg,\s*video\s*\{[^}]*max-width:\s*100%/);
  });
});

describe('accessibility basics in the stylesheet', () => {
  it('never removes focus outlines without providing a replacement', () => {
    const removals = [...css.matchAll(/outline:\s*(none|0)\b/g)];
    for (const r of removals) {
      const around = css.slice(Math.max(0, r.index! - 300), r.index! + 300);
      expect(around, 'outline removed with no visible focus replacement')
        .toMatch(/box-shadow|outline-offset|border-color/);
    }
  });

  it('defines a visible focus style for keyboard users', () => {
    expect(css).toMatch(/:focus-visible/);
  });
});

/**
 * Dead rules accumulate silently.
 *
 * A redesign replaces markup; the stylesheet keeps the old rules because nothing
 * errors. This file found 23 orphans in one pass — the whole of the previous offer
 * card (`.offer`, `.offer-main`, `.offer-side`, `.os-*`), the home panchang band it
 * replaced (`.panchang-band`, `.pcard`, `.panchang-head`), three badge variants no
 * card ever passes, and `.rail-hint` left behind when the carousel became a grid.
 *
 * Worse than the bytes: an orphan rule reads as live to the next person, who styles
 * against it and cannot work out why nothing moves.
 *
 * Dynamic class names are matched too — `` `wt ${or.weight}` `` yields `optional`
 * from the surrounding source — so this errs towards silence rather than towards
 * deleting something that is used.
 */
describe('no dead rules in the stylesheet', () => {
  /**
   * The components, plus the shared config they build class names from.
   *
   * `.occ-ritual .wt.optional` is applied as `` `wt ${or.weight}` ``, and `weight`
   * is a union declared in `packages/region/src/occasions.ts` — the string
   * "optional" appears nowhere in `apps/web`. Scanning only the app would have
   * reported a live rule as dead, and the obedient next step is to delete it.
   */
  const regionSrc = join(__dirname, '..', '..', '..', 'packages', 'region', 'src');
  const shared = readdirSync(regionSrc)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(regionSrc, f), 'utf8'));
  const tsxAll = [...sources.map((f) => readFileSync(f, 'utf8')), ...shared].join('\n');

  const declared = new Set<string>();
  for (const sel of css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g) ?? []) {
    if (sel.includes('@')) continue;
    for (const m of sel.matchAll(/\.([a-zA-Z][\w-]*)/g)) declared.add(m[1]!);
  }

  const used = new Set<string>();
  for (const m of tsxAll.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g)) {
    for (const part of m.slice(1)) {
      for (const t of part?.match(/[a-zA-Z][\w-]*/g) ?? []) used.add(t);
    }
  }
  // Class names assembled from string literals elsewhere in the component.
  for (const m of tsxAll.matchAll(/['"]([a-z][\w-]*)['"]/g)) used.add(m[1]!);

  it('every class in globals.css appears in some component', () => {
    const orphans = [...declared].filter((c) => !used.has(c)).sort();
    expect(
      orphans,
      `these rules style nothing, and read as live to whoever edits next:\n  ${orphans.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is scanning a real stylesheet and real components', () => {
    expect(declared.size).toBeGreaterThan(200);
    expect(used.size).toBeGreaterThan(200);
  });
});

/**
 * A snapping scroller must declare where its snapport starts.
 *
 * The footer's city row rested one gutter to the left of the "We serve" label above
 * it, with the first city's name half-eaten by the edge mask. Nothing was wrong with
 * the padding: `scroll-snap-align: start` aligns an item to the SNAPPORT, the
 * snapport defaults to the scrollport's padding box, and `scroll-padding` was unset
 * — so the browser's idea of "start" was the element edge, 20px left of where the
 * padding had placed the first chip. `proximity` snapped there on load, unasked.
 *
 * Three scrollers shipped this. The one in the footer is the one somebody happened
 * to look at. So the rule is checked rather than the instance: if a block both pads
 * itself inline and snaps, it must say where the snapport begins.
 */
describe('full-bleed scrollers line up with the gutter', () => {
  /**
   * Innermost rules only. `[^{}]` on BOTH sides is what makes this work inside a
   * media query: a selector cannot span a brace, so the engine backtracks past
   * `@media (...) {` and lands on the rule actually carrying the declarations.
   * Matching `[^}]*` for the body instead swallowed every nested rule into its
   * wrapper, which is why this suite first reported it had nothing to check.
   */
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [...stripped.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1]!.trim().replace(/\s+/g, ' '), body: m[2]! }))
    .filter((b) => b.selector !== '' && !b.selector.startsWith('@'));

  const snappers = blocks.filter(
    (b) => /scroll-snap-type:\s*x/.test(b.body) && /padding-inline:/.test(b.body),
  );

  it('finds the scrollers to check', () => {
    expect(snappers.length).toBeGreaterThanOrEqual(3);
  });

  for (const b of snappers) {
    it(`${b.selector} declares scroll-padding-inline`, () => {
      expect(b.body, `${b.selector} snaps to its element edge, not its gutter`)
        .toMatch(/scroll-padding-inline:/);
    });
  }

  /**
   * The negative margin and the padding must be the same number as `.wrap`'s, or the
   * row sits off the grid. Writing all three as the same variable is what makes that
   * true by construction instead of by three people remembering.
   */
  it('measures the bleed against the shared gutter, never a bare number', () => {
    for (const b of snappers) {
      expect(b.body, `${b.selector} hardcodes its inline padding`)
        .toMatch(/padding-inline:\s*var\(--gutter\)/);
      expect(b.body, `${b.selector} hardcodes its negative margin`)
        .toMatch(/margin-inline:\s*calc\(var\(--gutter\)/);
    }
  });

  it('pads the page by the same variable', () => {
    expect(css).toMatch(/\.wrap\s*\{[^}]*padding:\s*0 var\(--gutter\)/);
  });
});
