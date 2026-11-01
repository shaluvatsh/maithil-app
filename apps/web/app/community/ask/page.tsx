'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useRegion } from '@/lib/region-context';
import { Field } from '@/components/field';
import { languagesFor } from '@themaithil/region';
import { community, communityMessage } from '@/lib/community';
import { auth } from '@/lib/api';
import type { ContentLocale, PanjikaSchool } from '@themaithil/contracts';
import {
  TITLE_MIN, TITLE_MAX, BODY_MIN, BODY_MAX,
  citySpaceSlug, DEFAULT_SPACE_SLUG,
} from '@themaithil/contracts';

/**
 * Asking a question.
 *
 * The limits on this form are imported, not typed in. `TITLE_MIN` and friends come
 * from `packages/contracts`, so the character counter below and the API's rejection
 * are one number — a composer that lets you write a post the server will refuse is
 * the standard symptom of two copies of a constant.
 *
 * The three choices on the form are all pan-India decisions:
 *
 *   LANGUAGE is required and never defaulted to the app's language. Defaulting it
 *   would file every Chennai question as Bengali and route it to the wrong purohits.
 *   The options come from the region's own `locales`.
 *
 *   PANJIKA is optional and asked only because it changes whether an answer is true.
 *   The options are the almanacs this city actually keeps, in their own script.
 *
 *   SCOPE defaults to national, because a ritual question has the same answer
 *   everywhere and splitting it by city fragments the knowledge. The city option is
 *   for the genuinely local question.
 */
export default function AskPage() {
  const { t, region, locale: uiLocale } = useRegion();
  const router = useRouter();

  const [needsName, setNeedsName] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  /*
   * Defaults to the language they are READING in, not the city's first language.
   *
   * The app opens in English everywhere (ADR 0017); if someone has switched to
   * Bengali, that is the strongest available signal about what they will type. The
   * city's language list is a fact about the city and was never a statement about
   * this person — defaulting to it is what filed a Chennai question as Bengali.
   */
  const [locale, setLocale] = useState<ContentLocale>(uiLocale as ContentLocale);
  const [school, setSchool] = useState<string>('');
  const [scope, setScope] = useState<'national' | 'city'>('national');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!auth.token) router.replace('/login?next=/community/ask');
  }, [router]);

  // The stored preference arrives after mount, so the field has to follow it
  // rather than stay pinned to whatever the first render happened to pick.
  useEffect(() => { setLocale(uiLocale as ContentLocale); }, [uiLocale]);

  const titleOk = title.trim().length >= TITLE_MIN && title.trim().length <= TITLE_MAX;
  const bodyOk = body.trim().length >= BODY_MIN && body.trim().length <= BODY_MAX;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      if (needsName && displayName.trim()) await community.setProfile(displayName.trim());
      const res = await community.ask({
        // The slug convention has one owner in `packages/contracts`. Building it
        // here with a template literal would be a second copy, and a slug that
        // does not match fails as "no such space" rather than as anything a
        // reader could act on.
        spaceSlug: scope === 'city' ? citySpaceSlug(region.slug) : DEFAULT_SPACE_SLUG,
        title: title.trim(),
        body: body.trim(),
        locale,
        ...(school ? { panjikaSchool: school as PanjikaSchool } : {}),
        scope: scope === 'city' ? { scope: 'city', citySlug: region.slug } : { scope: 'national' },
      });
      if (res.state === 'held') { setMsg(t('community.held')); return; }
      router.push(`/community/${res.id}`);
    } catch (err) {
      // "Choose a display name before posting" arrives as NOT_FOUND from the API,
      // which is a precondition rather than a failure: show the field and let them
      // finish, instead of losing what they already typed.
      if ((err as { code?: string })?.code === 'NOT_FOUND' && !needsName) {
        setNeedsName(true);
        setMsg(t('community.chooseNameWhy'));
      } else {
        setMsg(communityMessage(err, t));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wrap cm-wrap cm-ask">
      <Link href="/community" className="btn-link cm-back">← {t('community.backToFeed')}</Link>
      <h1>{t('community.ask')}</h1>

      <form onSubmit={submit} className="cm-form">
        {needsName && (
          <Field id="ask-name" label={t('community.chooseName')}
                 hint={t('community.chooseNameWhy')}>
            <input
              id="ask-name" aria-describedby="ask-name-hint"
              value={displayName} onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t('community.displayName')} maxLength={60}
            />
          </Field>
        )}

        <Field id="ask-title" label={t('community.titleLabel')}
               hint={`${title.trim().length}/${TITLE_MAX}`}>
          <input
            id="ask-title" aria-describedby="ask-title-hint"
            value={title} onChange={(e) => setTitle(e.target.value)}
            lang={locale} maxLength={TITLE_MAX}
          />
        </Field>

        <Field id="ask-body" label={t('community.bodyLabel')}
               hint={`${body.trim().length}/${BODY_MAX}`}>
          <textarea
            id="ask-body" aria-describedby="ask-body-hint"
            rows={7} value={body} onChange={(e) => setBody(e.target.value)}
            lang={locale} maxLength={BODY_MAX}
          />
        </Field>

        <Field id="ask-lang" label={t('community.languageLabel')}>
          {/* Every language, this city's first. A migrant household writes in its
              own language wherever it lives — `languagesFor` exists for exactly
              this, and truncating to the city's list is the exclusion it replaced. */}
          <select id="ask-lang" value={locale}
                  onChange={(e) => setLocale(e.target.value as ContentLocale)}>
            {languagesFor(region.locales).map((l) => (
              <option key={l.code} value={l.code}>{l.native} — {l.en}</option>
            ))}
          </select>
        </Field>

        <Field id="ask-school" label={t('community.schoolLabel')}>
          <select id="ask-school" value={school} onChange={(e) => setSchool(e.target.value)}>
            <option value="">{t('community.schoolNone')}</option>
            {region.panjikas.map((p) => (
              <option key={p.id} value={p.id}>{p.native} — {p.english}</option>
            ))}
          </select>
        </Field>

        <fieldset className="cm-scope-field">
          <legend>{t('community.scopeLabel')}</legend>
          <label className="cm-radio">
            <input
              type="radio" name="scope" checked={scope === 'national'}
              onChange={() => setScope('national')}
            />
            {t('community.scopeNational')}
          </label>
          <label className="cm-radio">
            <input
              type="radio" name="scope" checked={scope === 'city'}
              onChange={() => setScope('city')}
            />
            {t('community.filterCity', { city: region.name.en })}
          </label>
        </fieldset>

        <button type="submit" className="btn" disabled={busy || !titleOk || !bodyOk}>
          {t('community.post')}
        </button>

        {msg && <p className="cm-notice">{msg}</p>}
      </form>
    </main>
  );
}
