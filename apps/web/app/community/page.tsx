'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRegion } from '@/lib/region-context';
import { community, ensureScriptFonts, type Post, type Feed } from '@/lib/community';
import { QuestionCard } from '@/components/community/post';
import { UpcomingCard } from '@/components/community/upcoming-card';
import { auth } from '@/lib/api';

/**
 * The question feed.
 *
 * Readable signed out, because a question a stranger can read is the entire
 * acquisition argument for building this. Signing in is only needed to write.
 *
 * SCOPE IS A CHOICE THE READER MAKES, not one inferred from their city. "Everywhere"
 * is the default because a question about annaprashan has the same answer in Pune
 * and in Guwahati and fragmenting that by city would fragment the one body of
 * knowledge the surface exists to accumulate. The city filter is there for the
 * genuinely local question — which ghat, which hall.
 */
export default function CommunityPage() {
  const { t, region } = useRegion();
  const [items, setItems] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [scope, setScope] = useState<'all' | 'city'>('all');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  // Read after mount: touching `auth` during render is a hydration mismatch, the
  // same reason the panchang page starts as `guest`.
  useEffect(() => { setSignedIn(Boolean(auth.token)); }, []);

  const load = useCallback(async (next?: string) => {
    setLoading(true);
    setErr(null);
    try {
      const res: Feed = await community.feed({
        ...(scope === 'city' ? { scope: 'city' as const, citySlug: region.slug } : {}),
        ...(next ? { cursor: next } : {}),
      });
      // Fetch exactly the faces this page now shows. Paging appends, so scripts
      // accumulate rather than reloading.
      ensureScriptFonts(res.scripts);
      setItems((prev) => (next ? [...prev, ...res.items] : res.items));
      setCursor(res.nextCursor);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [scope, region.slug]);

  useEffect(() => { void load(); }, [load]);

  return (
    <main className="wrap cm-wrap">
      {/* Above the questions on purpose: it is the reason to open the page on a
          day nobody has asked anything, and it costs no moderation. */}
      <UpcomingCard />

      <header className="cm-head">
        <h1>{t('community.title')}</h1>
        <p className="muted cm-blurb">
          {t('community.blurb')}{' '}
          {/* Reachable from the surface it governs, not only from the footer — and
              signed out, because the people most likely to need the grievance route
              are not necessarily the people with an account. */}
          <Link href="/community/guidelines" className="btn-link">
            {t('community.guidelines')}
          </Link>
        </p>

        <div className="cm-controls">
          <div className="cm-scope" role="group" aria-label={t('community.scopeLabel')}>
            <button
              type="button"
              className={`chip${scope === 'all' ? ' on' : ''}`}
              onClick={() => setScope('all')}
            >
              {t('community.filterAll')}
            </button>
            <button
              type="button"
              className={`chip${scope === 'city' ? ' on' : ''}`}
              onClick={() => setScope('city')}
            >
              {t('community.filterCity', { city: region.name.en })}
            </button>
          </div>

          <Link
            href={signedIn ? '/community/ask' : '/login?next=/community/ask'}
            className="btn sm"
          >
            {signedIn ? t('community.ask') : t('community.signInToAsk')}
          </Link>
        </div>
      </header>

      {err && <p className="cm-error">{err}</p>}

      {!loading && !err && items.length === 0 && (
        <p className="muted cm-empty">{t('community.empty')}</p>
      )}

      <div className="cm-list">
        {items.map((p) => <QuestionCard key={p.id} post={p} />)}
      </div>

      {loading && <p className="muted">{t('common.loading')}</p>}

      {cursor && !loading && (
        <button type="button" className="btn outline cm-more" onClick={() => void load(cursor)}>
          {t('community.loadMore')}
        </button>
      )}
    </main>
  );
}
