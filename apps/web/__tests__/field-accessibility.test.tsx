import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RegionProvider } from '@/lib/region-context';
import { Field } from '@/components/field';
import AskPage from '@/app/community/ask/page';
import HostEventPage from '@/app/events/new/page';
import WriteKnowledgePage from '@/app/learn/new/page';
import { createTranslator, getRegion, DEFAULT_LOCALE } from '@themaithil/region';

/**
 * A field's accessible name must be its label, and nothing else.
 *
 * THE BUG THIS PINS, which shipped in three forms. Every field was a wrapping label
 * with the hint inside it:
 *
 *     <label>Title <input/> <span>0/160</span></label>
 *
 * A wrapping `<label>` contributes its whole text content to the accessible name, so
 * that input is called "Title 0/160" — and the counter changes on every keystroke, so
 * the field is RENAMED as the user types. A screen reader announces the counter as
 * part of the field's identity, on every character.
 *
 * These tests look at the name rather than at the markup, so they keep holding
 * however the markup is rewritten — and they fail for a fourth form that repeats the
 * mistake.
 */
const t = createTranslator(getRegion('kolkata'), DEFAULT_LOCALE);

const json = (b: unknown) => new Response(JSON.stringify(b), {
  status: 200, headers: { 'content-type': 'application/json' },
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('themaithil.token', 'test-token');
  localStorage.setItem('themaithil.role', 'pandit');
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/rituals')) return json([{ slug: 'annaprashan', name: 'Annaprashan' }]);
    return json({ id: '01J00000000000000000000FA' });
  }) as unknown as typeof fetch;
});

describe('Field', () => {
  it('names the control from the label alone', () => {
    render(
      <Field id="x" label="Title" hint="0/160">
        <input id="x" aria-describedby="x-hint" />
      </Field>,
    );
    // Exactly "Title", not "Title 0/160".
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
  });

  it('puts the hint in the description, where it may change freely', () => {
    render(
      <Field id="x" label="Title" hint="0/160">
        <input id="x" aria-describedby="x-hint" />
      </Field>,
    );
    expect(screen.getByLabelText('Title'))
      .toHaveAccessibleDescription('0/160');
  });

  it('renders no description element when there is no hint', () => {
    render(<Field id="x" label="Title"><input id="x" /></Field>);
    expect(document.getElementById('x-hint')).toBeNull();
  });
});

/**
 * One case per form. `getByLabelText` matches on the ACCESSIBLE NAME, so each of
 * these fails outright if the hint leaks back into the label — which is precisely how
 * the defect was found in the first place.
 */
describe('every authoring form names its fields cleanly', () => {
  it('community/ask', () => {
    render(<RegionProvider><AskPage /></RegionProvider>);
    expect(screen.getByLabelText(t('community.titleLabel'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('community.bodyLabel'))).toBeInTheDocument();
    // The counter is a description, so it does not rename the field as you type.
    expect(screen.getByLabelText(t('community.titleLabel')))
      .toHaveAccessibleDescription(/\/180$/);
  });

  it('events/new', () => {
    render(<RegionProvider><HostEventPage /></RegionProvider>);
    expect(screen.getByLabelText(t('events.fTitle'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('events.fVenueName'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('events.fPincode')))
      .toHaveAccessibleDescription(t('events.fPincodeWhy'));
  });

  it('learn/new', () => {
    render(<RegionProvider><WriteKnowledgePage /></RegionProvider>);
    expect(screen.getByLabelText(t('learn.fHeading'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('learn.fBody'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('learn.fSlug')))
      .toHaveAccessibleDescription(t('learn.fSlugWhy'));
  });

  /**
   * The structural guard, and it is narrower than "no wrapping labels".
   *
   * A wrapping label around a RADIO or a CHECKBOX is correct and idiomatic: the
   * label's text IS the name, there is no counter to pollute it, and wrapping makes
   * the text itself clickable — which matters more on a phone than anywhere else.
   *
   * The defect was specific to fields that carry a hint: a text input, a textarea or
   * a select with a counter or an explanation inside the label. Those are what this
   * forbids, and the distinction is the rule rather than an exemption from it.
   */
  it('wraps no text field in a label, while leaving radios alone', () => {
    for (const Page of [AskPage, HostEventPage, WriteKnowledgePage]) {
      const { container, unmount } = render(<RegionProvider><Page /></RegionProvider>);

      const offenders = [...container.querySelectorAll('label')].filter((l) => {
        const control = l.querySelector('input, textarea, select');
        if (!control) return false;
        const type = control.getAttribute('type');
        return !(type === 'radio' || type === 'checkbox');
      });
      expect(offenders.map((l) => l.textContent)).toEqual([]);

      // And the radios that remain are named by their own text, which is the point
      // of wrapping them.
      const radios = [...container.querySelectorAll('input[type=radio]')];
      for (const r of radios) expect(r.closest('label')).not.toBeNull();

      unmount();
    }
  });
});
