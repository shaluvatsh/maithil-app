import type { Metadata } from 'next';
import Link from 'next/link';
import { getKnowledge } from '@/lib/server-api';
import { LearnCard } from '@/components/learn/card';

export const metadata: Metadata = {
  title: 'Learn — TheMaithil',
  description:
    'How Hindu rituals are performed, explained by verified purohits and checked before publication.',
};

/**
 * The library.
 *
 * A SERVER component, unlike the community feed. A published item is identical for
 * every reader and carries no per-viewer state, so it can be rendered on the server,
 * cached, and read by a crawler — which is the whole acquisition argument. The feed
 * could not be: it renders `viewerHasPranamed`, so a shared cache there would hand
 * one devotee another's reaction state.
 *
 * ADR 0008 cut `devotee-web` as "a third frontend". This is the asset it was cut
 * for, living inside the app that already exists.
 */
export const revalidate = 3600;

const TABS = [
  { key: '', label: 'Everything' },
  { key: 'ritual_guide', label: 'Ritual guides' },
  { key: 'mantra_audio', label: 'Mantras to listen to' },
  { key: 'article', label: 'Articles' },
] as const;

export default async function LearnPage(
  { searchParams }: { searchParams: Promise<{ type?: string }> },
) {
  const { type } = await searchParams;
  /*
   * No `limit`. The server's `COMMUNITY_FEED_PAGE_SIZE` owns it — passing one here
   * would be a second copy of a number an operator is supposed to be able to tune
   * against real latency, and it would silently override them.
   */
  const { items } = await getKnowledge(type ? { type } : {});

  return (
    <main className="wrap lr-wrap">
      <header className="lr-head">
        <h1>Learn</h1>
        <p className="muted lr-blurb">
          Explanations of how rituals are performed, written by purohits and checked by
          another before they appear here.
        </p>

        {/*
          * Links rather than buttons, so each filter is a real URL a crawler can
          * follow and a reader can share. A client-side tab would make four pages of
          * content reachable only by tapping.
          */}
        {/*
          * Writing and reviewing, side by side.
          *
          * The queue link is shown to everyone rather than gated on role: the
          * endpoint is `@Roles('pandit','admin','ops')` and refuses anybody else, and
          * a link that appears only for people who already know they can review is a
          * link no new reviewer ever finds. A devotee who follows it is told why.
          */}
        <p className="lr-links">
          <Link href="/learn/new" className="btn sm">Write something</Link>{' '}
          <Link href="/learn/queue" className="btn outline sm">Waiting to be checked</Link>
        </p>

        <nav className="lr-tabs">
          {TABS.map((tab) => (
            <Link
              key={tab.key}
              href={tab.key ? `/learn?type=${tab.key}` : '/learn'}
              className={`chip${(type ?? '') === tab.key ? ' on' : ''}`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </header>

      {items.length === 0 && <p className="muted lr-empty">Nothing published yet.</p>}

      <div className="lr-list">
        {items.map((item) => <LearnCard key={item.id} item={item} />)}
      </div>
    </main>
  );
}
