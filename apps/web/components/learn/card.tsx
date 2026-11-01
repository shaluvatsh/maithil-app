'use client';
import Link from 'next/link';
import { fontPlan } from '@themaithil/region';
import { useRegion } from '@/lib/region-context';
import { scriptOf } from '@/lib/community';
import type { KnowledgeSummary } from '@/lib/server-api';

/**
 * One item in the library.
 *
 * Two things every card must carry, and they are the reason this surface is worth
 * building at all:
 *
 *   WHO CHECKED IT. Named, always. Every other app in this category publishes
 *   unsourced text; "somebody qualified read this and put their name to it" is the
 *   whole proposition, and an unattributed claim of review is worth nothing.
 *
 *   WHETHER THIS IS THE AUTHOR'S OWN WORDS. The API serves a fallback language when
 *   the reader's is missing, and says so. Rendering a translation as though it were
 *   the original is the quiet kind of dishonesty that costs trust later.
 */
export function LearnCard({ item }: { item: KnowledgeSummary }) {
  const { t, numerals } = useRegion();
  const plan = fontPlan(scriptOf(item.locale));

  return (
    <Link href={`/learn/${item.slug}`} className="lr-card">
      <span className="lr-kind">
        {item.type === 'mantra_audio' ? '🔊' : item.type === 'video' ? '▶' : '📖'}
        {' '}{item.level === 'beginner' ? t('learn.beginner') : t('learn.deep')}
        {item.durationSec !== null && (
          <> · {t('learn.minutes', { count: numerals(Math.ceil(item.durationSec / 60)) })}</>
        )}
      </span>

      {/* Typeset in the language it is being served in, which may not be the app's. */}
      <h2 className="lr-title" lang={item.locale} style={{ fontFamily: plan.vars.ui }}>
        {item.title}
      </h2>
      <p className="lr-summary" lang={item.locale}>{item.summary}</p>

      <span className="lr-by muted">
        {t('learn.by', { name: item.authorName })}
        {item.authorVerified && <span className="lr-tick"> ✓</span>}
        {item.reviewedByName && <> · {t('learn.reviewedBy', { name: item.reviewedByName })}</>}
        {item.citationCount > 0 && <> · {numerals(item.citationCount)} 📚</>}
      </span>
    </Link>
  );
}
