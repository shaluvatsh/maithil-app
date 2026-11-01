'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRegion } from '@/lib/region-context';
import { Field } from '@/components/field';
import { api, auth } from '@/lib/api';
import { languagesFor } from '@themaithil/region';
import {
  KnowledgeType, KnowledgeLevel, isMediaType,
  TITLE_MIN_K, TITLE_MAX_K, SUMMARY_MIN, SUMMARY_MAX, BODY_MIN_K, BODY_MAX_K,
  type ContentLocale, type KnowledgeType as KType,
} from '@themaithil/contracts';

/**
 * Writing for the library.
 *
 * ANYONE SIGNED IN MAY WRITE, and the form says why that is safe: nothing appears
 * until somebody else has read it. A devotee's account of their own family's practice
 * is valuable, and gating authorship rather than publication would lose it — so the
 * check lives at the review step, which is also where it is enforced in SQL.
 *
 * The transcript field appears only for a recording, and the copy explains that it is
 * required rather than marking it with an asterisk: a mantra with no written form
 * cannot be searched, cannot be read along with, and is unusable by anyone who cannot
 * hear it. That is why the API refuses to accept one without it.
 */
const TEXT_TYPES: Array<{ value: KType; label: string }> = [
  { value: 'ritual_guide', label: 'A guide to one ritual' },
  { value: 'article', label: 'An article' },
  { value: 'mantra_audio', label: 'A mantra, recorded' },
  { value: 'shloka', label: 'A shloka and its meaning' },
  { value: 'glossary', label: 'A word explained' },
];

interface Ritual { slug: string; name: string }
interface CitationRow { work: string; chapter: string; verse: string }

export default function WriteKnowledgePage() {
  const { t, region, locale: uiLocale } = useRegion();
  const router = useRouter();

  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    setSignedIn(Boolean(auth.token));
    if (!auth.token) router.replace('/login?next=/learn/new');
  }, [router]);

  const [type, setType] = useState<KType>('ritual_guide');
  const [level, setLevel] = useState<'beginner' | 'deep'>('beginner');
  const [slug, setSlug] = useState('');
  const [locale, setLocale] = useState<ContentLocale>(uiLocale as ContentLocale);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [transcript, setTranscript] = useState('');
  const [ritualSlug, setRitualSlug] = useState('');
  const [mediaKey, setMediaKey] = useState('');
  const [uploading, setUploading] = useState(false);
  const [citations, setCitations] = useState<CitationRow[]>([{ work: '', chapter: '', verse: '' }]);
  const [rituals, setRituals] = useState<Ritual[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { setLocale(uiLocale as ContentLocale); }, [uiLocale]);

  // The catalogue, so a guide can be attached to the ritual it explains — which is
  // what puts it on that ritual's own page.
  useEffect(() => {
    void api<Ritual[]>(`/v1/rituals?citySlug=${region.slug}`, { auth: false })
      .then(setRituals).catch(() => setRituals([]));
  }, [region.slug]);

  const needsMedia = isMediaType(type);
  const ok = slug.length >= 3
    && title.trim().length >= TITLE_MIN_K
    && summary.trim().length >= SUMMARY_MIN
    && body.trim().length >= BODY_MIN_K
    && (!needsMedia || (mediaKey !== '' && transcript.trim().length > 0));

  /**
   * Upload the recording, then keep only the key.
   *
   * The key is chosen by the server and the content type is signed with it, so this
   * cannot be pointed at somebody else's file or used to push an HTML document into
   * a public bucket.
   */
  async function upload(file: File) {
    setUploading(true); setMsg(null);
    try {
      const signed = await api<{ url: string; key: string }>('/v1/knowledge/upload-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentType: file.type }),
      });
      const put = await fetch(signed.url, {
        method: 'PUT', headers: { 'content-type': file.type }, body: file,
      });
      if (!put.ok) throw new Error('the upload did not go through');
      setMediaKey(signed.key);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  async function save(thenSubmit: boolean) {
    setBusy(true); setMsg(null);
    try {
      const created = await api<{ id: string }>('/v1/knowledge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug, type, level, primaryLocale: locale,
          ...(ritualSlug ? { ritualSlug } : {}),
          ...(mediaKey ? { mediaKey } : {}),
          text: [{
            locale, title: title.trim(), summary: summary.trim(), body: body.trim(),
            ...(transcript.trim() ? { transcript: transcript.trim() } : {}),
          }],
          // Blank rows are dropped rather than rejected: an empty "add another"
          // sitting at the bottom of a form is not an error the author made.
          citations: citations
            .filter((c) => c.work.trim())
            .map((c) => ({
              work: c.work.trim(),
              ...(c.chapter.trim() ? { chapter: c.chapter.trim() } : {}),
              ...(c.verse.trim() ? { verse: c.verse.trim() } : {}),
            })),
        }),
      });

      if (!thenSubmit) { setMsg(t('learn.savedDraft')); return; }
      await api(`/v1/knowledge/${created.id}/submit`, { method: 'POST' });
      setMsg(t('learn.sentForReview'));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn) {
    return (
      <main className="wrap lr-wrap">
        <Link href="/login?next=/learn/new" className="btn">{t('learn.signInToWrite')}</Link>
      </main>
    );
  }

  return (
    <main className="wrap lr-wrap lr-write">
      <Link href="/learn" className="btn-link lr-back">← {t('learn.backToLearn')}</Link>
      <h1>{t('learn.write')}</h1>
      <p className="muted lr-blurb">{t('learn.writeBlurb')}</p>

      <form className="lr-form" onSubmit={(e) => { e.preventDefault(); void save(true); }}>
        <Field id="k-type" label={t('learn.fType')}>
          <select id="k-type" value={type} onChange={(e) => setType(e.target.value as KType)}>
            {/* From the contract enum, filtered to the ones a person writes. */}
            {TEXT_TYPES.filter((x) => KnowledgeType.options.includes(x.value)).map((x) => (
              <option key={x.value} value={x.value}>{x.label}</option>
            ))}
          </select>
        </Field>

        <Field id="k-level" label={t('learn.fLevel')}>
          <select id="k-level" value={level}
                  onChange={(e) => setLevel(e.target.value as 'beginner' | 'deep')}>
            {KnowledgeLevel.options.map((l) => (
              <option key={l} value={l}>
                {l === 'beginner' ? t('learn.beginner') : t('learn.deep')}
              </option>
            ))}
          </select>
        </Field>

        <Field id="k-slug" label={t('learn.fSlug')} hint={t('learn.fSlugWhy')}>
          <input
            id="k-slug" aria-describedby="k-slug-hint" value={slug} maxLength={120}
            // Normalised as they type rather than rejected afterwards: the rule is
            // lowercase-hyphenated, and enforcing it here means the contract's regex
            // never has to refuse a form somebody spent ten minutes on.
            onChange={(e) => setSlug(
              e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, ''),
            )}
          />
        </Field>

        <Field id="k-lang" label={t('learn.fLang')}>
          <select id="k-lang" value={locale}
                  onChange={(e) => setLocale(e.target.value as ContentLocale)}>
            {languagesFor(region.locales).map((l) => (
              <option key={l.code} value={l.code}>{l.native} — {l.en}</option>
            ))}
          </select>
        </Field>

        <Field id="k-title" label={t('learn.fHeading')}
               hint={`${title.trim().length}/${TITLE_MAX_K}`}>
          <input
            id="k-title" aria-describedby="k-title-hint"
            value={title} lang={locale} maxLength={TITLE_MAX_K}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>

        <Field id="k-summary" label={t('learn.fSummary')}
               hint={`${summary.trim().length}/${SUMMARY_MAX} · at least ${SUMMARY_MIN}`}>
          <textarea
            id="k-summary" aria-describedby="k-summary-hint"
            rows={2} value={summary} lang={locale} maxLength={SUMMARY_MAX}
            onChange={(e) => setSummary(e.target.value)}
          />
        </Field>

        <Field id="k-body" label={t('learn.fBody')}
               hint={`${body.trim().length}/${BODY_MAX_K} · at least ${BODY_MIN_K}`}>
          <textarea
            id="k-body" aria-describedby="k-body-hint"
            rows={12} value={body} lang={locale} maxLength={BODY_MAX_K}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>

        {needsMedia && (
          <>
            <Field
              id="k-media" label={t('learn.fMedia')}
              hint={uploading ? t('learn.uploading') : (mediaKey ? '✓' : undefined)}
            >
              <input
                id="k-media" type="file" accept="audio/mpeg,audio/mp4,video/mp4"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
              />
            </Field>

            {/* Why, not an asterisk. */}
            <Field id="k-transcript" label={t('learn.fTranscript')}
                   hint={t('learn.fTranscriptWhy')}>
              <textarea
                id="k-transcript" aria-describedby="k-transcript-hint"
                rows={5} value={transcript} lang={locale} maxLength={BODY_MAX_K}
                onChange={(e) => setTranscript(e.target.value)}
              />
            </Field>
          </>
        )}

        <Field id="k-ritual" label={t('learn.fRitual')}>
          <select id="k-ritual" value={ritualSlug}
                  onChange={(e) => setRitualSlug(e.target.value)}>
            <option value="">{t('learn.fRitualNone')}</option>
            {rituals.map((r) => <option key={r.slug} value={r.slug}>{r.name}</option>)}
          </select>
        </Field>

        <fieldset className="lr-cites">
          <legend>{t('learn.fCitations')}</legend>
          <p className="muted cm-small">{t('learn.citationsWhy')}</p>
          {citations.map((c, i) => (
            <div key={i} className="lr-cite-row">
              <input
                placeholder={t('learn.fCitationWork')} value={c.work}
                onChange={(e) => setCitations(
                  citations.map((x, j) => (j === i ? { ...x, work: e.target.value } : x)),
                )}
              />
              <input
                placeholder={t('learn.fCitationChapter')} value={c.chapter}
                onChange={(e) => setCitations(
                  citations.map((x, j) => (j === i ? { ...x, chapter: e.target.value } : x)),
                )}
              />
              <input
                placeholder={t('learn.fCitationVerse')} value={c.verse}
                onChange={(e) => setCitations(
                  citations.map((x, j) => (j === i ? { ...x, verse: e.target.value } : x)),
                )}
              />
            </div>
          ))}
          <button
            type="button" className="btn ghost sm"
            onClick={() => setCitations([...citations, { work: '', chapter: '', verse: '' }])}
          >
            {t('learn.addCitation')}
          </button>
        </fieldset>

        <div className="lr-actions">
          <button type="button" className="btn outline" disabled={busy || !ok}
                  onClick={() => void save(false)}>
            {t('learn.saveDraft')}
          </button>
          <button type="submit" className="btn" disabled={busy || !ok}>
            {t('learn.submit')}
          </button>
        </div>

        {msg && <p className="lr-notice">{msg}</p>}
      </form>
    </main>
  );
}
