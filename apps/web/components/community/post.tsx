'use client';
import Link from 'next/link';
import { useMemo } from 'react';
import { fontPlan, allRegions } from '@themaithil/region';
import { REDACTION_TOKEN } from '@themaithil/contracts';
import { useRegion } from '@/lib/region-context';
import { scriptOf, type Post } from '@/lib/community';

/**
 * Rendering a post written by a stranger, possibly in a script the reader's own
 * city does not use.
 *
 * Two things this does that no other surface in the app has to:
 *
 *   1. The TEXT is typeset in the writer's script, from `post.locale`. Not the
 *      region's — a national feed carries three at once, and `region.script` cannot
 *      describe it. `lang` is set too, so the browser's own line-breaking and
 *      hyphenation follow the language rather than the page.
 *   2. The NUMBERS are in the reader's numerals, from `useRegion()`. A count is
 *      chrome, not content: a Bengali reader expects ৮৪ whoever wrote the answer.
 *
 * The split matters. Typesetting a Tamil answer in Bengali numerals would be as
 * wrong as the reverse, and collapsing the two is the tell that a pan-India product
 * was built in one city.
 */

/** Font family and optical correction for one post's script, from region config. */
function useScriptStyle(locale: string) {
  return useMemo(() => {
    const plan = fontPlan(scriptOf(locale));
    return {
      fontFamily: plan.vars.ui,
      // Indic glyphs are optically smaller than Latin at the same point size, and
      // the correction differs per script. Without it two answers side by side look
      // like different weights.
      fontSize: `${plan.opticalScale}em`,
    };
  }, [locale]);
}

/**
 * The body, with the contact sentinel turned into something a reader understands.
 *
 * The API sends `[[redacted:contact]]` rather than English because it does not know
 * what language the reader wants. Anything that renders the sentinel raw is a
 * missing translation, which is visible — the alternative is a silently English
 * string sitting inside a Tamil answer, which is not.
 */
export function PostBody({ post }: { post: Post }) {
  const { t } = useRegion();
  const style = useScriptStyle(post.locale);
  const parts = post.body.split(REDACTION_TOKEN);

  return (
    <p className="cm-body" lang={post.locale} style={style}>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 && (
            <span className="cm-redacted" title={t('community.redactedWhy')}>
              {t('community.redacted')}
            </span>
          )}
        </span>
      ))}
    </p>
  );
}

export function AuthorLine({ post }: { post: Post }) {
  const { t, numerals } = useRegion();
  const a = post.author;

  return (
    <div className="cm-author">
      <span className={`cm-avatar${a.verifiedPurohit ? ' verified' : ''}`} aria-hidden>
        {a.avatarUrl
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={a.avatarUrl} alt="" />
          : a.displayName.slice(0, 1)}
      </span>
      <span className="cm-author-name">{a.displayName}</span>
      {a.verifiedPurohit && (
        <>
          <span className="cm-tick" title={t('community.verified')}>✓</span>
          {a.experienceYears !== null && (
            <span className="muted cm-small">
              {t('community.years', { count: numerals(a.experienceYears) })}
            </span>
          )}
          {a.panjikaSchool && (
            <span className="muted cm-small">· {schoolName(a.panjikaSchool)}</span>
          )}
        </>
      )}
    </div>
  );
}

/**
 * An almanac's name, from region config rather than a lookup table here.
 *
 * Every region declares the panjikas its households keep, with a native-script name
 * — so the label a Chennai reader sees for Vakya Panchangam is the one Chennai's own
 * config supplies, not a translation of a Bengali label.
 */
function schoolName(id: string): string {
  for (const region of allRegions()) {
    const p = region.panjikas.find((x) => x.id === id);
    if (p) return p.native;
  }
  return id;
}

/** The panjika qualifier. A calendar answer is only true under one almanac. */
export function SchoolTag({ post }: { post: Post }) {
  const { t } = useRegion();
  if (!post.panjikaSchool) return null;
  return (
    <span className="cm-school">
      {t('community.accordingTo', { school: schoolName(post.panjikaSchool) })}
    </span>
  );
}

export function QuestionCard({ post }: { post: Post }) {
  const { t, numerals } = useRegion();
  const style = useScriptStyle(post.locale);

  return (
    <Link href={`/community/${post.id}`} className="cm-card">
      <h3 className="cm-title" lang={post.locale} style={style}>{post.title}</h3>
      <PostBody post={post} />
      <div className="cm-foot">
        <AuthorLine post={post} />
        <span className="cm-counts muted">
          {post.replyCount === 1
            ? t('community.answersOne')
            : t('community.answers', { count: numerals(post.replyCount) })}
          {post.pranamCount > 0 && <> · 🙏 {numerals(post.pranamCount)}</>}
        </span>
      </div>
      <SchoolTag post={post} />
    </Link>
  );
}
