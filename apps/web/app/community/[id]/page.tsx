'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRegion } from '@/lib/region-context';
import { languagesFor } from '@themaithil/region';
import {
  community, ensureScriptFonts, communityMessage, type Thread, type Answer,
} from '@/lib/community';
import { PostBody, AuthorLine, SchoolTag } from '@/components/community/post';
import { auth } from '@/lib/api';

/**
 * One thread.
 *
 * THE ORDER IS THE PRODUCT and it is decided server-side: accepted answer, then
 * verified purohits, then endorsements, then pranams. The client renders what it is
 * given and never re-sorts — a board where the front end could reorder answers is a
 * board whose ordering guarantee is a suggestion.
 *
 * Verified answers are also visually separated rather than merely first, because
 * "first" is invisible once a reader has scrolled.
 */
export default function ThreadPage() {
  const { t, numerals } = useRegion();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  const [thread, setThread] = useState<Thread | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setSignedIn(Boolean(auth.token));
    setRole(auth.role);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await community.thread(id);
      ensureScriptFonts(res.scripts);
      setThread(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => { if (id) void load(); }, [id, load]);

  if (err) return <main className="wrap cm-wrap"><p className="cm-error">{err}</p></main>;
  if (!thread) return <main className="wrap cm-wrap"><p className="muted">{t('common.loading')}</p></main>;

  const { question, answers } = thread;
  const verified = answers.filter((a) => a.author.verifiedPurohit);
  const others = answers.filter((a) => !a.author.verifiedPurohit);

  return (
    <main className="wrap cm-wrap">
      <Link href="/community" className="btn-link cm-back">← {t('community.backToFeed')}</Link>

      <article className="cm-question">
        <h1 lang={question.locale}>{question.title}</h1>
        <PostBody post={question} />
        <SchoolTag post={question} />
        <div className="cm-foot"><AuthorLine post={question} /></div>
      </article>

      {answers.length === 0 && <p className="muted cm-empty">{t('community.noAnswers')}</p>}

      {verified.map((a) => (
        <AnswerBlock key={a.id} answer={a} questionId={question.id} onChange={load} />
      ))}

      {others.length > 0 && (
        <details className="cm-others">
          <summary>
            {t('community.moreAnswers')} ({numerals(others.length)})
          </summary>
          {others.map((a) => (
            <AnswerBlock key={a.id} answer={a} questionId={question.id} onChange={load} />
          ))}
        </details>
      )}

      {signedIn && <Composer parentId={question.id} onDone={load} />}

      {role === 'pandit' && (
        <p className="muted cm-small cm-note">{t('community.verifiedAnswer')}</p>
      )}
    </main>
  );
}

function AnswerBlock({
  answer, questionId, onChange,
}: { answer: Answer; questionId: string; onChange: () => Promise<void> }) {
  const { t, numerals } = useRegion();
  const [busy, setBusy] = useState(false);
  const [reported, setReported] = useState(false);
  const verified = answer.author.verifiedPurohit;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await onChange(); } finally { setBusy(false); }
  };

  return (
    <article className={`cm-answer${verified ? ' verified' : ''}${answer.isAcceptedAnswer ? ' accepted' : ''}`}>
      {verified && <span className="cm-badge">{t('community.verifiedAnswer')}</span>}
      {answer.isAcceptedAnswer && <span className="cm-badge accepted">{t('community.accepted')}</span>}

      <AuthorLine post={answer} />
      <PostBody post={answer} />
      <SchoolTag post={answer} />

      {answer.endorsementCount > 0 && (
        <p className="cm-agree">
          {answer.endorsementCount === 1
            ? t('community.agreeOne')
            : t('community.agree', { count: numerals(answer.endorsementCount) })}
        </p>
      )}

      <div className="cm-actions">
        <button
          type="button" disabled={busy}
          className={`btn sm ghost${answer.viewerHasPranamed ? ' on' : ''}`}
          onClick={() => void act(() => community.pranam(answer.id, !answer.viewerHasPranamed))}
        >
          🙏 {t('community.pranam')} {answer.pranamCount > 0 && numerals(answer.pranamCount)}
        </button>

        {/*
          * The booking CTA, on the answer itself.
          *
          * This is the whole commercial argument for the surface and the reason
          * contact details are stripped from the body above: the path of least
          * resistance to "this person knows what they are talking about" has to
          * lead back through the platform, where the escrow and the refund live.
          */}
        {verified && (
          <Link href={`/book?panditId=${answer.author.id}`} className="btn sm">
            {t('community.book')}
          </Link>
        )}

        <button
          type="button" disabled={busy || reported} className="btn sm ghost cm-report"
          onClick={() => void act(async () => {
            await community.report(answer.id, 'other');
            setReported(true);
          })}
        >
          {reported ? t('community.reported') : t('community.report')}
        </button>
      </div>

      {answer.replies.length > 0 && (
        <div className="cm-replies">
          {answer.replies.map((r) => (
            <div key={r.id} className="cm-reply">
              <AuthorLine post={r} />
              <PostBody post={r} />
            </div>
          ))}
        </div>
      )}

      <AcceptButton questionId={questionId} answerId={answer.id} onDone={onChange} />
    </article>
  );
}

/**
 * Only the asker sees this, and the server enforces that — the button is hidden on a
 * 403 rather than the permission being decided here.
 */
function AcceptButton({
  questionId, answerId, onDone,
}: { questionId: string; answerId: string; onDone: () => Promise<void> }) {
  const { t } = useRegion();
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <button
      type="button" className="btn sm outline cm-accept"
      onClick={async () => {
        try { await community.accept(questionId, answerId); await onDone(); }
        catch { setHidden(true); }
      }}
    >
      {t('community.accepted')}
    </button>
  );
}

function Composer({ parentId, onDone }: { parentId: string; onDone: () => Promise<void> }) {
  const { t, region, locale: uiLocale } = useRegion();
  const [body, setBody] = useState('');
  // The language they are reading in, not the city's first. See the ask page.
  const [locale, setLocale] = useState<string>(uiLocale);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="cm-composer"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setMsg(null);
        try {
          const res = await community.respond(parentId, { body, locale: locale as never });
          setBody('');
          setMsg(res.state === 'held' ? t('community.held') : null);
          await onDone();
        } catch (err) {
          setMsg(communityMessage(err, t));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor="cm-reply-body">{t('community.answer')}</label>
      <textarea
        id="cm-reply-body" rows={4} value={body} lang={locale}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="cm-composer-foot">
        {/* Every language, this city's first — never a fixed list. */}
        <select value={locale} onChange={(e) => setLocale(e.target.value)} aria-label={t('community.languageLabel')}>
          {languagesFor(region.locales).map((l) => (
            <option key={l.code} value={l.code}>{l.native}</option>
          ))}
        </select>
        <button type="submit" className="btn sm" disabled={busy || body.trim().length === 0}>
          {t('community.post')}
        </button>
      </div>
      {msg && <p className="cm-notice">{msg}</p>}
    </form>
  );
}
