import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FestivalWorksheet } from '@/components/admin/festival-worksheet';

/**
 * The transcription worksheet.
 *
 * Designed for one situation: somebody with a physical panjika open, working through
 * a list. Everything asserted here follows from that — the gaps are the interface,
 * nothing is computed, and a changed date is a delete-then-insert because
 * `festival_dates` is unique on (school, festival, date).
 */
const ROWS = [
  {
    festivalId: 'durga-puja', en: 'Durga Puja',
    blurb: 'Shashthi to Dashami — four days.',
    days: 4, regions: ['kolkata', 'guwahati'],
    id: null, date: null, endsOn: null,
  },
  {
    festivalId: 'diwali', en: 'Diwali', blurb: 'Lamps and the household Lakshmi puja.',
    days: 1, regions: [],
    id: '01J0000000000000000000FW', date: '2026-11-08', endsOn: null,
  },
];

const json = (b: unknown) => new Response(JSON.stringify(b), {
  status: 200, headers: { 'content-type': 'application/json' },
});

const mount = (calls: Array<{ url: string; method: string; body: unknown }> = []) => {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url, method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.includes('/admin/panchang/festivals?')) {
      return json({
        school: 'gupta_press', from: '2026-01-01', to: '2026-12-31',
        rows: ROWS, remaining: 1,
      });
    }
    return json({ ok: true });
  }) as unknown as typeof fetch;
  return render(<FestivalWorksheet />);
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('themaithil.token', 'test-token');
  localStorage.setItem('themaithil.role', 'ops');
});

describe('the gaps are the interface', () => {
  it('lists a festival with no date as prominently as one with', async () => {
    mount();
    // A screen showing only what exists cannot tell you what is left.
    expect(await screen.findByText('Durga Puja')).toBeInTheDocument();
    expect(screen.getByText('Diwali')).toBeInTheDocument();
  });

  it('says at the top how many still need a date', async () => {
    mount();
    await screen.findByText('Durga Puja');
    expect(screen.getByText(/still need a date/)).toBeInTheDocument();
  });

  it('marks the rows already recorded', async () => {
    mount();
    await screen.findByText('Diwali');
    const done = screen.getByText('Diwali').closest('li')!;
    // Recedes visually so the eye lands on the gaps.
    expect(done.className).toContain('done');
    expect(screen.getByText('Durga Puja').closest('li')!.className).not.toContain('done');
  });

  it('says plainly that nothing here is computed', async () => {
    mount();
    await screen.findByText('Durga Puja');
    // ADR 0003: the almanacs disagree and a date we derived would contradict the book
    // a household actually keeps.
    expect(screen.getByText(/Nothing here is computed/)).toBeInTheDocument();
  });
});

describe('what each row asks for', () => {
  it('asks for an end date only on a multi-day festival', async () => {
    mount();
    await screen.findByText('Durga Puja');
    // An end date nobody needs is a field somebody will fill in wrongly.
    expect(screen.getByLabelText('Durga Puja last day')).toBeInTheDocument();
    expect(screen.queryByLabelText('Diwali last day')).toBeNull();
  });

  it('shows who observes it, so a transcriber can skip the irrelevant', async () => {
    mount();
    await screen.findByText('Durga Puja');
    expect(screen.getByText(/kolkata, guwahati · 4 days/)).toBeInTheDocument();
    expect(screen.getByText('everywhere we serve')).toBeInTheDocument();
  });

  it('pre-fills a date already transcribed, so a sitting can be resumed', async () => {
    mount();
    const input = await screen.findByLabelText('Diwali start date');
    expect((input as HTMLInputElement).value).toBe('2026-11-08');
  });
});

describe('saving', () => {
  it('commits on blur, with no save button to forget', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const user = userEvent.setup();
    mount(calls);
    const input = await screen.findByLabelText('Durga Puja start date');

    await user.type(input, '2026-10-17');
    await user.tab();

    // An hour of transcription must not be lost to a closed tab.
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body).toMatchObject({ festivalId: 'durga-puja', date: '2026-10-17' });
    });
  });

  it('sends the school with every entry, because a date belongs to one almanac', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const user = userEvent.setup();
    mount(calls);
    await user.type(await screen.findByLabelText('Durga Puja start date'), '2026-10-17');
    await user.tab();

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body).toMatchObject({ school: expect.any(String) });
    });
  });

  /**
   * The constraint that shapes this: `festival_dates` is unique on
   * (school, festival, date), so an upsert keyed on the date cannot change the date.
   */
  it('deletes before re-inserting when a date is corrected', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const user = userEvent.setup();
    mount(calls);
    const input = await screen.findByLabelText('Diwali start date');

    await user.clear(input);
    await user.type(input, '2026-11-07');
    await user.tab();

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE'
        && c.url.includes('01J0000000000000000000FW'))).toBe(true);
    });
    const order = calls.filter((c) => c.method !== 'GET').map((c) => c.method);
    expect(order).toEqual(['DELETE', 'POST']);
  });

  it('clearing a date removes the entry and leaves the gap', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const user = userEvent.setup();
    mount(calls);
    const input = await screen.findByLabelText('Diwali start date');

    await user.clear(input);
    await user.tab();

    // How somebody undoes a misreading.
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('does not write when nothing changed', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const user = userEvent.setup();
    mount(calls);
    const input = await screen.findByLabelText('Diwali start date');

    await user.click(input);
    await user.tab();

    // Blur alone must not churn the table, or a scroll past a row rewrites it.
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});
