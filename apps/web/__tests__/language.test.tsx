import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider, useRegion } from '@/lib/region-context';
import { LanguagePicker } from '@/components/language-picker';
import { LanguageOffer } from '@/components/language-offer';
import { navFor, roleOf } from '@/lib/nav-model';
import {
  DEFAULT_LOCALE, availableLocales, getRegion, allRegions,
  NUMERALS_FOR_LOCALE, createTranslator, LANGUAGES,
} from '@themaithil/region';

/**
 * English by default, in every city, with the reader free to change it. ADR 0017.
 *
 * The rule this replaces was `region.locales[0]` — Kolkata opened in Bengali
 * because Kolkata speaks Bengali. That confused a fact about a CITY with a fact
 * about a VISITOR, and it did so on first paint, before anyone could say otherwise.
 */

beforeEach(() => {
  localStorage.clear();
  global.fetch = vi.fn(async () => new Response('[]', {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
});

/** A probe that renders what the provider is actually handing components. */
function Probe() {
  const { locale, numerals, t, region } = useRegion();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="city">{region.slug}</span>
      <span data-testid="count">{numerals(84)}</span>
      <span data-testid="nav">{t('nav.book')}</span>
    </div>
  );
}

const renderProbe = () => render(
  <RegionProvider><LanguagePicker /><Probe /></RegionProvider>,
);

describe('the app opens in English everywhere', () => {
  it('defaults to English in the launch city, which speaks Bengali', () => {
    renderProbe();
    expect(screen.getByTestId('city')).toHaveTextContent('kolkata');
    expect(screen.getByTestId('locale')).toHaveTextContent(DEFAULT_LOCALE);
    expect(screen.getByTestId('nav')).toHaveTextContent('Book');
  });

  it('uses Latin digits by default, whatever the city’s own numerals are', () => {
    // Kolkata's region config says Bengali numerals; that is the CITY's default,
    // for anything formatted without a reader. The reader here is on English.
    expect(getRegion('kolkata').numerals).toBe('beng');
    renderProbe();
    expect(screen.getByTestId('count')).toHaveTextContent('84');
  });

  it('would open in English in every region, not just the launch city', () => {
    // Asserted over the whole registry rather than one city, because the previous
    // rule was per-region and this one deliberately is not.
    for (const region of allRegions()) {
      const t = createTranslator(region, DEFAULT_LOCALE);
      expect(t('nav.book'), region.slug).toBe('Book');
    }
  });
});

describe('the reader can change it, and it sticks', () => {
  it('switches the interface, the digits and the stored preference', async () => {
    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByRole('button', { name: /Language/i }));
    await user.click(screen.getByRole('option', { name: /বাংলা/ }));

    await waitFor(() => {
      expect(screen.getByTestId('locale')).toHaveTextContent('bn');
    });
    // Chrome follows the language...
    expect(screen.getByTestId('nav')).toHaveTextContent('বুকিং');
    // ...and so do the digits, which is the half that is easy to miss.
    expect(screen.getByTestId('count')).toHaveTextContent('৮৪');
    expect(localStorage.getItem('themaithil.locale')).toBe('bn');
  });

  it('restores the preference on the next visit', async () => {
    localStorage.setItem('themaithil.locale', 'hi');
    renderProbe();
    await waitFor(() => {
      expect(screen.getByTestId('locale')).toHaveTextContent('hi');
    });
    expect(screen.getByTestId('count')).toHaveTextContent('८४');
  });

  it('ignores a stored value that is not a language rather than crashing', async () => {
    localStorage.setItem('themaithil.locale', 'klingon');
    renderProbe();
    await act(async () => {});
    expect(screen.getByTestId('locale')).toHaveTextContent(DEFAULT_LOCALE);
  });

  it('is independent of the city — changing one does not reset the other', async () => {
    const user = userEvent.setup();
    renderProbe();
    await user.click(screen.getByRole('button', { name: /Language/i }));
    await user.click(screen.getByRole('option', { name: /বাংলা/ }));
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('bn'));

    expect(localStorage.getItem('themaithil.locale')).toBe('bn');
    // Two preferences, two keys. Inferring one from the other is the bug this fixes.
    expect(localStorage.getItem('themaithil.city')).toBeNull();
  });
});

describe('the picker itself', () => {
  it('labels every option in its own script', async () => {
    const user = userEvent.setup();
    renderProbe();
    await user.click(screen.getByRole('button', { name: /Language/i }));

    // Scoped to the menu: the pill also shows the current language's native name,
    // so an unscoped query matches it twice and proves nothing about the options.
    const menu = screen.getByRole('listbox');
    // A picker that lists languages in the language you are trying to leave is the
    // most common way this control fails.
    for (const code of availableLocales(getRegion('kolkata'))) {
      expect(within(menu).getByText(LANGUAGES[code].native), code).toBeInTheDocument();
    }
  });

  it('offers a language even where the city does not speak it', () => {
    // Chennai speaks Tamil, Telugu and English; only English has a dictionary. A
    // Bengali family living there must still be able to read the app in Bengali.
    const chennai = availableLocales(getRegion('chennai'));
    expect(chennai).toContain('bn');
    expect(chennai).toContain('en');
    // The city's own languages still lead, so the common case is at the top.
    expect(chennai[0]).toBe('en');
  });
});

describe('numerals are a property of the language, not the city', () => {
  it('gives every locale digits, so a new language cannot render as boxes', () => {
    for (const code of Object.keys(LANGUAGES) as Array<keyof typeof LANGUAGES>) {
      expect(NUMERALS_FOR_LOCALE[code], code).toBeTruthy();
    }
  });

  it('maps English to Latin digits and Bengali to Bengali digits', () => {
    expect(NUMERALS_FOR_LOCALE.en).toBe('latn');
    expect(NUMERALS_FOR_LOCALE.bn).toBe('beng');
    expect(NUMERALS_FOR_LOCALE.mr).toBe('deva');
  });
});

/**
 * The one-time offer that replaced the header control.
 *
 * The header picker was removed because it paid permanent chrome for an action
 * almost nobody repeats. That is only defensible if something still reaches the
 * reader who cannot read the page they landed on — this is that something, and
 * these tests are what stop it quietly regressing into a banner nobody sees.
 */
describe('the language offer', () => {
  const renderOffer = () => render(
    <RegionProvider><LanguageOffer /><Probe /></RegionProvider>,
  );

  it('offers the city’s own language, written in that language', async () => {
    renderOffer();
    // Kolkata's first language is Bengali, and the invitation is in Bengali —
    // asking "read this in Bengali?" in English asks the question in the language
    // the reader is struggling with.
    const offer = await screen.findByText('বাংলায় পড়ুন');
    expect(offer).toHaveAttribute('lang', 'bn');
  });

  it('switches the language when accepted', async () => {
    const user = userEvent.setup();
    renderOffer();
    await screen.findByText('বাংলায় পড়ুন');

    await user.click(screen.getByRole('button', { name: 'বাংলা' }));
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('bn'));
    expect(localStorage.getItem('themaithil.locale')).toBe('bn');
  });

  it('is an offer, not a nag — dismissing it is remembered', async () => {
    const user = userEvent.setup();
    const { unmount } = renderOffer();
    await screen.findByText('বাংলায় পড়ুন');

    await user.click(screen.getByRole('button', { name: 'না, থাক' }));
    await waitFor(() => expect(screen.queryByText('বাংলায় পড়ুন')).toBeNull());
    // Still English: declining is a decision, not a deferral.
    expect(screen.getByTestId('locale')).toHaveTextContent(DEFAULT_LOCALE);

    unmount();
    renderOffer();
    await act(async () => {});
    expect(screen.queryByText('বাংলায় পড়ুন')).toBeNull();
  });

  it('never appears for someone who has already chosen', async () => {
    localStorage.setItem('themaithil.locale', 'bn');
    renderOffer();
    await act(async () => {});
    expect(screen.queryByText('বাংলায় পড়ুন')).toBeNull();
  });

  it('stays silent where the city’s language is not translated', async () => {
    // Chennai speaks Tamil and Telugu; neither has a dictionary. Offering English
    // to someone already reading English is noise, so nothing is shown.
    localStorage.setItem('themaithil.city', 'chennai');
    renderOffer();
    await act(async () => {});
    expect(screen.getByTestId('city')).toHaveTextContent('chennai');
    expect(document.querySelector('.lang-offer')).toBeNull();
  });
});

describe('the header no longer carries a language control', () => {
  it('keeps it out of the nav model’s links', () => {
    // The picker was never a nav link, but this pins the intent: chrome is for
    // things people use repeatedly, and language is not one of them.
    const hrefs = navFor(roleOf(false, null)).links.map((l) => l.href);
    expect(hrefs).not.toContain('/language');
  });
});
