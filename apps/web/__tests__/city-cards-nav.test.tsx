import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { navFor } from '@/lib/nav-model';
import {
  getRegion, formatMoney, RITUAL_CATEGORIES, RITUAL_EMOJI, emojiFor, aliasesFor,
} from '@themaithil/region';

const css = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');
const home = readFileSync(join(__dirname, '..', 'app', 'page.tsx'), 'utf8');

const at = (bp: string) => {
  const marker = `@media (max-width: ${bp})`;
  const out: string[] = [];
  for (let i = css.indexOf(marker); i >= 0; i = css.indexOf(marker, i + 1)) {
    const j = css.indexOf('\n@media', i + marker.length);
    out.push(css.slice(i, j < 0 ? undefined : j));
  }
  return out.join('\n');
};

/**
 * A purohit's header opened on "My jobs", the calendar icon pointed at "My jobs",
 * and the account dropdown offered "My jobs" — the same destination three ways,
 * which reads as a rendering fault rather than as emphasis.
 */
describe('no role is offered the same destination twice', () => {
  for (const role of ['guest', 'devotee', 'pandit', 'admin'] as const) {
    it(`${role}: the account menu repeats nothing from the bar`, () => {
      const nav = navFor(role);
      const bar = new Set(nav.links.map((l) => l.href));
      for (const item of nav.account) {
        expect(bar.has(item.href), `${role} sees ${item.href} in both the bar and the menu`)
          .toBe(false);
      }
    });

    it(`${role}: no destination appears twice in the bar`, () => {
      const hrefs = navFor(role).links.map((l) => l.href);
      expect(new Set(hrefs).size).toBe(hrefs.length);
    });
  }

  /**
   * The bar and the icon may share a destination — one is a label, one is a badge —
   * but the mobile sheet renders both as text rows, so it must de-duplicate.
   */
  it('the mobile sheet drops an activity link the bar already carries', () => {
    const nav = readFileSync(join(__dirname, '..', 'app', 'nav.tsx'), 'utf8');
    expect(nav).toMatch(/!nav\.links\.some\(\(l\) => l\.href === nav\.activity!\.href\)/);
  });
});

/**
 * Two card languages on one page made the closing pair read as advertising rather
 * than as part of the catalogue. They now use the category tile's parts.
 */
describe('the closing cards match the category tiles', () => {
  it('are whole-card links, not panels with a button', () => {
    expect(home).toMatch(/<Link[^>]*className="outcard"/);
  });

  it('carry a tile, a name and a description like a category card', () => {
    const block = /<div className="outband">([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/.exec(home)?.[1] ?? '';
    expect(block).toMatch(/className="tile"/);
    expect(block).toMatch(/className="name"/);
    expect(block).toMatch(/className="desc"/);
  });

  it('are centred and flat, not gradient panels', () => {
    const rule = /(^|})\s*\.outcard\s*\{([^}]*)\}/m.exec(css)?.[2] ?? '';
    expect(rule).toMatch(/text-align:\s*center/);
    expect(rule).toMatch(/background:\s*var\(--white\)/);
  });
});

/**
 * A 46% card is ~155px on a 360px phone. The desktop card packs a tinted header,
 * a badge, a rating, two chips, two feature ticks, a meta row, a price and two
 * buttons into that. Squeezing it is not making it responsive.
 */
describe('service cards become tiles on a phone', () => {
  const mobile = at('640px');

  it('centres the card and gives the emoji a tile', () => {
    expect(mobile).toMatch(/\.rail\s+\.svc-card\s*\{[^}]*text-align:\s*center/);
    expect(mobile).toMatch(/\.rail\s+\.svc-top\s+\.emoji\s*\{[^}]*border-radius/);
  });

  it('drops the rating, chips, ticks and meta row', () => {
    for (const cls of ['\\.rating', '\\.chips', '\\.badge', '\\.feats', '\\.meta']) {
      expect(mobile, `${cls} still renders inside a 155px card`)
        .toMatch(new RegExp(`\\.rail[^{]*${cls}[^{]*\\{[^}]*display:\\s*none`));
    }
  });

  it('leaves exactly one button', () => {
    expect(mobile).toMatch(/\.rail\s+\.svc-actions\s+\.btn\.outline\s*\{[^}]*display:\s*none/);
  });

  /**
   * Hiding "Learn More" must not hide the route. The heading is the link, so the
   * detail page stays reachable on the device most people arrive on.
   */
  it('keeps the detail page reachable through the title', () => {
    const card = readFileSync(
      join(__dirname, '..', 'components', 'home', 'service-card.tsx'), 'utf8');
    expect(card).toMatch(/<Link href={`\/pooja\/\$\{s\.slug\}`} className="title">/);
  });
});

describe('the services hub on a narrow screen', () => {
  const mobile = at('720px');

  it('scrolls the category jump bar rather than wrapping it', () => {
    expect(mobile).toMatch(/\.hub-jump\s*\{[^}]*overflow-x:\s*auto/);
    expect(mobile).toMatch(/\.hub-jump\s*\{[^}]*max-width:\s*100%/);
  });

  it('shows two catalogue cards across rather than one column of rows', () => {
    expect(mobile).toMatch(/\.hub-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
  });

  /**
   * Cards, not a price list. The hub rendered name / description / mode / price as
   * a two-column grid that degraded into four unstyled lines, so arriving here from
   * a category tile felt like leaving the product.
   */
  it('uses the same card shape as the home page shelves', () => {
    expect(css).toMatch(/\.hub-card\s*\{[^}]*border-radius:\s*var\(--radius-lg\)/);
    expect(css, 'the row layout should be gone entirely').not.toMatch(/\.hub-item/);
  });

  it('moves the group action below the group, not above it', () => {
    expect(mobile).toMatch(/\.hub-group-head\s+\.btn\s*\{[^}]*order:\s*3/);
  });
});

/**
 * The clearest defect when the service cards were put beside the category tiles:
 * a category read "5 services" and the card beneath it read "₹5,207.2".
 */
describe('prices are quoted in whole rupees', () => {
  const region = getRegion('kolkata');

  it('never renders a fraction of a rupee', () => {
    for (const paise of [520_720, 314_985, 1, 99, 150_050]) {
      expect(formatMoney(paise, region)).not.toMatch(/[.,]\d{1,2}$/);
    }
  });

  it('still groups in the Indian system', () => {
    expect(formatMoney(520_720, region)).toBe('₹5,207');
    expect(formatMoney(1_234_567_00, region)).toMatch(/12,34,567/);
  });

  /** The ledger and payout screens need the exact figure; nothing else does. */
  it('can still show paise when the exact figure is the point', () => {
    expect(formatMoney(520_720, region, { paise: true })).toBe('₹5,207.2');
  });

  /**
   * Rounding only at the formatter would leave the number and the string
   * disagreeing, so the home page rounds the figure itself.
   */
  it('rounds the home page estimate to the rupee at source', () => {
    expect(home).toMatch(/Math\.round\([\s\S]*?\/ 100\) \* 100/);
  });
});

describe('a service wears its category colour', () => {
  it('passes the category tint into the card', () => {
    expect(home).toMatch(/const tintOf = \(r: Ritual\) => getCategory\(r\.category\)\?\.tint/);
    expect(home).toMatch(/tint=\{tintOf\(r\)\}/);
  });

  it('gives every category a distinct tile colour to inherit', () => {
    const tints = RITUAL_CATEGORIES.map((c) => c.tint);
    expect(new Set(tints).size, 'two categories share a tint, so the colour means nothing')
      .toBe(tints.length);
  });

  /**
   * Four cards in a row all wearing the same orange are harder to scan than four
   * different ones — and the rail stopped looking related to the grid above it.
   */
  it('does not hardcode one gradient for every service tile', () => {
    const card = readFileSync(
      join(__dirname, '..', 'components', 'home', 'service-card.tsx'), 'utf8');
    expect(card).toMatch(/style=\{tint \? \{ background: tint \} : undefined\}/);
  });
});

/**
 * "Full Satyanarayan katha and puja with sinni" wraps to two lines and
 * "House-warming puja with homa" to one, so side by side the two cards' prices and
 * buttons sat at different heights.
 */
describe('cards in a row line up', () => {
  it('reserves two lines of description on a phone', () => {
    expect(at('640px')).toMatch(/\.rail\s+\.svc-body\s+\.desc\s*\{[^}]*min-height:/);
  });

  it('reserves two lines in the catalogue grid too', () => {
    expect(css).toMatch(/\.hc-desc\s*\{[^}]*min-height:/);
  });

  it('softens the card action so it does not outshout the service name', () => {
    expect(at('640px'))
      .toMatch(/\.rail\s+\.svc-actions\s+\.btn\s*\{[^}]*background:\s*var\(--orange-50\)/);
  });
});

/**
 * A background may only be applied to something that has a box.
 *
 * `.svc-top .emoji` was `font-size: 38px` on a block `div` with no width, height or
 * radius. The moment a category tint was passed to it as `background`, it painted
 * the full width of the card header — a solid colour band with an emoji floating on
 * it. A separate mobile rule gave it a box, which is exactly why the bug was
 * invisible on a phone and obvious on a laptop.
 */
describe('the card tile is a tile', () => {
  const rule = (sel: string) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[,}])\\s*${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[2] ?? '';
  };

  it('has a width, a height and a radius, not just a font size', () => {
    const tile = rule('.svc-top .emoji');
    expect(tile).toMatch(/width:\s*\d+px/);
    expect(tile).toMatch(/height:\s*\d+px/);
    expect(tile).toMatch(/border-radius/);
  });

  /** Anything given a `background` prop from data needs a box at every width. */
  it('is boxed outside any media query, not only on small screens', () => {
    // Every @media block removed, so what is left is what applies at all widths.
    const base = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    expect(base, 'the tile is only sized inside a breakpoint')
      .toMatch(/\.svc-top\s+\.emoji\s*\{[^}]*width:/);
  });

  it('matches the category tile it borrows its colour from', () => {
    const svc = parseFloat(/width:\s*(\d+)px/.exec(rule('.svc-top .emoji'))?.[1] ?? '0');
    const cat = parseFloat(/width:\s*(\d+)px/.exec(rule('.cat-card .tile'))?.[1] ?? '0');
    expect(Math.abs(svc - cat), 'the two tiles are noticeably different sizes')
      .toBeLessThanOrEqual(12);
  });

  /** Two tinted surfaces stacked made the top half of the card outweigh its name. */
  it('does not sit on a second tinted band', () => {
    expect(rule('.svc-top')).toMatch(/background:\s*none/);
  });
});

describe('cards and their actions are card-sized', () => {
  const padding = (sel: string) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = new RegExp(`(^|[,}])\\s*${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[2] ?? '';
    const m = /padding:\s*([\d.]+)px\s+([\d.]+)px/.exec(body);
    return m ? { y: parseFloat(m[1]!), x: parseFloat(m[2]!) } : null;
  };

  /**
   * Card actions inherited the page's primary button — sized for a form's submit —
   * so two of them side by side were taller than the price above them.
   */
  it('gives card actions a smaller button than a form submit', () => {
    const base = padding('.btn')!;
    const card = padding('.svc-actions .btn')!;
    expect(card.y).toBeLessThan(base.y);
  });

  it('fits four cards across a desktop row without them becoming posters', () => {
    const track = /\.grid\.svc\s*\{[^}]*minmax\((\d+)px/.exec(css)?.[1];
    expect(Number(track)).toBeLessThanOrEqual(260);
  });
});

describe('the closing pair is a pair', () => {
  const mobile = at('640px');

  it('shows both cards at once, in two equal columns', () => {
    expect(mobile).toMatch(/\.outband\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
  });

  /**
   * The pair used to be a snap carousel with a faded edge. Nothing is off-screen
   * now, so there is no cut to soften and no gesture to teach — the fade and the
   * hint were both scaffolding for a layout that no longer exists.
   */
  it('has no clipped edge left to fade', () => {
    const body = /\.outband\s*\{([^}]*)\}/.exec(mobile)?.[1] ?? '';
    expect(body).not.toMatch(/mask-image/);
    expect(body).not.toMatch(/overflow-x:\s*auto/);
  });

  it('does not animate the rail on its own', () => {
    const railBlock = /\.grid\.svc\.rail\s*\{([^}]*)\}/.exec(mobile)?.[1] ?? '';
    expect(railBlock).not.toMatch(/animation/);
  });
});

/**
 * Issues found by looking at the rendered page rather than the diff.
 */
describe('defects visible only once rendered', () => {
  const mobile = at('640px');

  /**
   * CSS divides free space EQUALLY between every `auto` margin in a flex line, so
   * two of them is not twice as anchored — it is not anchored at all. The base rule
   * put `margin-top: auto` on `.price` and a later fix added another to
   * `.svc-actions`, so a card taller than its content split the slack between them
   * and the gap under "Book Now" survived a change aimed directly at it.
   */
  it('has exactly one auto top margin inside a rail card', () => {
    const scope = mobile.match(/\.rail\s+\.(?:price|svc-actions|svc-body[^{]*)\s*\{[^}]*\}/g) ?? [];
    const autos = scope.filter((r) => /margin-top:\s*auto/.test(r));
    expect(autos.length, `slack splits between ${autos.length} auto margins`).toBe(1);
    expect(autos[0], 'the slack must collect above the action, not above the price')
      .toMatch(/svc-actions/);
  });

  /** A reserved second line under a one-word name reads as a missing element. */
  it('does not reserve a blank line under short titles', () => {
    const title = /\.rail\s+\.svc-body\s+\.title\s*\{([^}]*)\}/.exec(mobile)?.[1] ?? '';
    expect(title).not.toMatch(/min-height/);
  });

  /**
   * A 60px circle pinned bottom-right, over rails that run full-bleed to the same
   * edge, landed on a card's Book Now and on the second closing card.
   */
  it('keeps the floating WhatsApp button clear of the sticky action bar', () => {
    expect(mobile).toMatch(/\.wa\s*\{[^}]*bottom:\s*calc\(9\d+px/);
    expect(css, 'the button must respect the home indicator')
      .toMatch(/\.wa\s*\{[^}]*env\(safe-area-inset-bottom\)/);
  });

  /** The one scroller without a fade, so a city name was sliced mid-word. */
  it('fades the footer city row like every other scroller', () => {
    expect(at('720px')).toMatch(/\.fcities\s+\.chips\s*\{[^}]*mask-image/);
  });

  /** #94A3B8 on white is 2.56:1; AA wants 4.5:1 for text this size. */
  it('does not print the swipe hint below the contrast floor', () => {
    const hint = /\.rail-hint\s*\{([^}]*)\}/.exec(mobile)?.[1] ?? '';
    expect(hint).not.toMatch(/color:\s*var\(--faint\)/);
  });

  /**
   * Every virtual service was drawn as the same laptop in the same blue, so two
   * different products sat side by side looking like one card rendered twice.
   */
  /**
   * Every virtual service was drawn as the same laptop in the same blue, so two
   * different products sat side by side looking like one card rendered twice.
   */
  it('gives every ritual its own icon', () => {
    const glyphs = Object.values(RITUAL_EMOJI);
    expect(glyphs.length).toBeGreaterThan(15);
    expect(new Set(glyphs).size, 'two rituals share an icon').toBe(glyphs.length);
  });

  it('names the online services explicitly rather than falling back', () => {
    for (const slug of ['online-aarti', 'virtual-consultation', 'personalised-puja']) {
      expect(RITUAL_EMOJI[slug], `${slug} has no icon of its own`).toBeTruthy();
    }
    expect(emojiFor('online-aarti')).not.toBe(emojiFor('virtual-consultation'));
  });

  /**
   * These maps lived in `app/page.tsx`, so the same ritual wore a different face
   * on the home page than in the booking catalogue, and "housewarming" matched in
   * the hero and nowhere else. Presentation belongs with the taxonomy.
   */
  it('keeps ritual presentation out of the page component', () => {
    expect(home, 'the emoji map is back in the page').not.toMatch(/const EMOJI/);
    expect(home, 'the alias map is back in the page').not.toMatch(/const ALIASES/);
    expect(home).toMatch(/emojiFor|aliasesFor/);
  });

  it('gives the search aliases people actually type', () => {
    expect(aliasesFor('griha-prabesh')).toContain('housewarming');
    expect(aliasesFor('biye')).toContain('wedding');
    expect(aliasesFor('nothing-like-this')).toEqual([]);
  });

  it('tints the online rail from its category too', () => {
    const rail = /railOf\('online'\)[\s\S]*?<\/ServiceRail>/.exec(home)?.[0] ?? '';
    expect(rail).toMatch(/tint=\{tintOf\(r\)\}/);
  });
});
