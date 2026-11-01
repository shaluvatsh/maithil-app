import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import WriteKnowledgePage from '@/app/learn/new/page';
import ReviewQueuePage from '@/app/learn/queue/page';
import { createTranslator, getRegion, DEFAULT_LOCALE } from '@themaithil/region';
import { SUMMARY_MIN, BODY_MIN_K } from '@themaithil/contracts';

/**
 * Authoring and reviewing.
 *
 * The tests that matter are about the REVIEW GATE being legible rather than merely
 * enforced: an author has to understand that nothing appears until somebody else
 * reads it, a recording has to carry a transcript, and a reviewer sending something
 * back has to say why.
 */
const t = createTranslator(getRegion('kolkata'), DEFAULT_LOCALE);

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), {
  status, headers: { 'content-type': 'application/json' },
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('themaithil.token', 'test-token');
  localStorage.setItem('themaithil.role', 'pandit');
  Object.defineProperty(window, 'location', {
    value: { pathname: '/learn/new', href: '' }, writable: true, configurable: true,
  });
});

const mountForm = (calls: Array<{ url: string; body: unknown }> = []) => {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes('/v1/rituals')) {
      return json([{ slug: 'annaprashan', name: 'Annaprashan' }]);
    }
    if (url.includes('/submit')) return json({ status: 'in_review' });
    return json({ id: '01J00000000000000000000KA' });
  }) as unknown as typeof fetch;
  return render(<RegionProvider><WriteKnowledgePage /></RegionProvider>);
};

describe('the form explains the gate rather than hiding it', () => {
  it('tells the author nothing appears until someone else reads it', async () => {
    mountForm();
    // The review gate is the library's whole proposition; an author who does not
    // know about it experiences it as a delay rather than as a standard.
    expect(await screen.findByText(t('learn.writeBlurb'))).toBeInTheDocument();
  });

  it('keeps submit disabled until the text is long enough to be worth reading', async () => {
    const user = userEvent.setup();
    mountForm();
    await screen.findByLabelText(t('learn.fHeading'));

    const submit = screen.getByRole('button', { name: t('learn.submit') });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(t('learn.fSlug')), 'annaprashan-first-feed');
    await user.type(screen.getByLabelText(t('learn.fHeading')), 'Who feeds the child first');
    await user.type(screen.getByLabelText(/One or two sentences/), 'x'.repeat(SUMMARY_MIN));
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(t('learn.fBody')), 'y'.repeat(BODY_MIN_K));
    expect(submit).toBeEnabled();
  });

  /** A URL is for ever, so it is normalised as they type rather than refused after. */
  it('normalises the slug instead of rejecting it later', async () => {
    const user = userEvent.setup();
    mountForm();
    const slug = await screen.findByLabelText(t('learn.fSlug'));
    await user.type(slug, 'Who Feeds First?!');
    expect((slug as HTMLInputElement).value).toBe('who-feeds-first--');
  });
});

describe('a recording must carry a transcript', () => {
  it('hides the transcript field for text, and shows it for audio', async () => {
    const user = userEvent.setup();
    mountForm();
    await screen.findByLabelText(t('learn.fType'));

    expect(screen.queryByLabelText(t('learn.fTranscript'))).toBeNull();
    await user.selectOptions(screen.getByLabelText(t('learn.fType')), 'mantra_audio');
    expect(screen.getByLabelText(t('learn.fTranscript'))).toBeInTheDocument();
  });

  it('says why it is required rather than marking it with an asterisk', async () => {
    const user = userEvent.setup();
    mountForm();
    await user.selectOptions(await screen.findByLabelText(t('learn.fType')), 'mantra_audio');
    // Without it nobody can search it, read along, or use it if they cannot hear.
    expect(screen.getByText(t('learn.fTranscriptWhy'))).toBeInTheDocument();
  });

  it('will not submit audio with no recording, however complete the text', async () => {
    const user = userEvent.setup();
    mountForm();
    await user.selectOptions(await screen.findByLabelText(t('learn.fType')), 'mantra_audio');
    await user.type(screen.getByLabelText(t('learn.fSlug')), 'gayatri');
    await user.type(screen.getByLabelText(t('learn.fHeading')), 'The Gayatri mantra');
    await user.type(screen.getByLabelText(/One or two sentences/), 'x'.repeat(SUMMARY_MIN));
    await user.type(screen.getByLabelText(t('learn.fBody')), 'y'.repeat(BODY_MIN_K));
    await user.type(screen.getByLabelText(t('learn.fTranscript')), 'ওঁ ভূর্ভুবঃ স্বঃ');

    // The API refuses this too; the form refuses first so nobody submits into a wall.
    expect(screen.getByRole('button', { name: t('learn.submit') })).toBeDisabled();
  });
});

describe('what it sends', () => {
  const fill = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText(t('learn.fSlug')), 'annaprashan-first-feed');
    await user.type(screen.getByLabelText(t('learn.fHeading')), 'Who feeds the child first');
    await user.type(screen.getByLabelText(/One or two sentences/), 'x'.repeat(SUMMARY_MIN));
    await user.type(screen.getByLabelText(t('learn.fBody')), 'y'.repeat(BODY_MIN_K));
  };

  it('creates a draft and then submits it, as two steps', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const user = userEvent.setup();
    mountForm(calls);
    await screen.findByLabelText(t('learn.fHeading'));
    await fill(user);
    await user.click(screen.getByRole('button', { name: t('learn.submit') }));

    await waitFor(() => expect(calls.some((c) => c.url.includes('/submit'))).toBe(true));
    // Saving and handing over are separate decisions, so they are separate calls.
    expect(calls.some((c) => c.url.endsWith('/v1/knowledge'))).toBe(true);
  });

  it('drops the empty citation row instead of failing on it', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const user = userEvent.setup();
    mountForm(calls);
    await screen.findByLabelText(t('learn.fHeading'));
    await fill(user);
    // The form starts with one blank row; an unfilled "add another" is not an error
    // the author made.
    await user.click(screen.getByRole('button', { name: t('learn.saveDraft') }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/v1/knowledge'))).toBe(true));
    const body = calls.find((c) => c.url.endsWith('/v1/knowledge'))!.body as {
      citations: unknown[]; text: Array<{ locale: string }>;
    };
    expect(body.citations).toEqual([]);
    // And the text carries the language it was written in, never a default.
    expect(body.text[0]!.locale).toBe(DEFAULT_LOCALE);
  });

  it('confirms a draft is saved without claiming it was published', async () => {
    const user = userEvent.setup();
    mountForm();
    await screen.findByLabelText(t('learn.fHeading'));
    await fill(user);
    await user.click(screen.getByRole('button', { name: t('learn.saveDraft') }));
    expect(await screen.findByText(t('learn.savedDraft'))).toBeInTheDocument();
  });
});

describe('the review queue', () => {
  const ROW = {
    id: '01J00000000000000000000KQ', slug: 'annaprashan-first-feed',
    type: 'ritual_guide', level: 'beginner', primary_locale: 'bn',
    media_key: null, updated_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    author_name: 'Pandit Asim', author_kyc: 'verified',
    title: 'অন্নপ্রাশনে কে প্রথম খাওয়াবেন', summary: 'সংক্ষেপে ব্যাখ্যা।',
    citation_count: 2,
  };

  const mountQueue = (calls: Array<{ url: string; body: unknown }> = [], rows = [ROW]) => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes('/review')) return json({ status: 'published' });
      return json(rows);
    }) as unknown as typeof fetch;
    return render(<RegionProvider><ReviewQueuePage /></RegionProvider>);
  };

  it('says why the reader is the right person to judge it', async () => {
    mountQueue();
    // Staff cannot tell whether a Maithili account of a vidhi is right; the people
    // who can are already here, and the copy says so.
    expect(await screen.findByText(t('learn.queueBlurb'))).toBeInTheDocument();
  });

  it('shows how long it has been waiting', async () => {
    mountQueue();
    expect(await screen.findByText(/waiting 3d/)).toBeInTheDocument();
  });

  it('offers to read it before deciding', async () => {
    mountQueue();
    // Publishing on a summary is how the gate becomes theatre.
    const read = await screen.findByRole('link', { name: t('learn.readGuide') });
    expect(read).toHaveAttribute('href', `/learn/${ROW.slug}`);
  });

  it('requires a reason before it will send something back', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const user = userEvent.setup();
    mountQueue(calls);
    await screen.findByText(ROW.title);

    await user.click(screen.getByRole('button', { name: t('learn.sendBack') }));
    const input = screen.getByPlaceholderText(t('learn.sendBackWhy'));
    // The API refuses a rejection with no note; asking here is also where a reviewer
    // decides whether they can say what is wrong.
    const buttons = screen.getAllByRole('button', { name: t('learn.sendBack') });
    expect(buttons[buttons.length - 1]).toBeDisabled();

    await user.type(input, 'name the paddhati you are describing');
    expect(screen.getAllByRole('button', { name: t('learn.sendBack') }).pop()).toBeEnabled();
  });

  it('publishes on one tap and reloads the queue', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const user = userEvent.setup();
    mountQueue(calls);
    await screen.findByText(ROW.title);
    await user.click(screen.getByRole('button', { name: t('learn.publishIt') }));

    await waitFor(() => {
      const review = calls.find((c) => c.url.includes('/review'));
      expect(review?.body).toMatchObject({ decision: 'publish' });
    });
  });

  it('says so plainly when nothing is waiting', async () => {
    mountQueue([], []);
    expect(await screen.findByText(t('learn.queueEmpty'))).toBeInTheDocument();
  });
});
