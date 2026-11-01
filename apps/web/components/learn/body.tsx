'use client';
import { useState } from 'react';
import { fontPlan } from '@themaithil/region';
import { scriptOf } from '@/lib/community';
import type { KnowledgeItem } from '@/lib/server-api';

/**
 * The body, and the recording where there is one.
 *
 * AUDIO FIRST, deliberately. `chantingSampleUrl` exists on a purohit profile because
 * devotees judge shuddha uchcharan and no competitor lets them hear it; the same
 * insight applied to teaching is a mantra with correct pronunciation. It also reaches
 * the households who speak their language fluently and read their own script slowly.
 *
 * The transcript is always present and starts collapsed. Collapsed because most
 * people want to listen; always present because a recording with no written form
 * cannot be read along with and is inaccessible to anyone who cannot hear it — which
 * is why the API refuses to publish one without it.
 */
export function LearnBody({ item }: { item: KnowledgeItem }) {
  const [open, setOpen] = useState(false);
  const plan = fontPlan(scriptOf(item.locale));

  return (
    <>
      {item.mediaUrl && (
        <div className="lr-media">
          {item.type === 'video'
            // eslint-disable-next-line jsx-a11y/media-has-caption
            ? <video controls src={item.mediaUrl} preload="metadata" />
            : <audio controls src={item.mediaUrl} preload="metadata" />}
        </div>
      )}

      {item.transcript && (
        <details className="lr-transcript" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>What is being said</summary>
          <p lang={item.locale} style={{ fontFamily: plan.vars.ui }}>{item.transcript}</p>
        </details>
      )}

      {/*
        * `white-space: pre-wrap` rather than a markdown renderer.
        *
        * The body is author-written text from the library, not from a forum — but it
        * is still text a human typed, and rendering it as HTML would be a stored-XSS
        * hole for the sake of bold type. Paragraphs are what the content needs.
        */}
      <div className="lr-body" lang={item.locale} style={{ fontFamily: plan.vars.ui }}>
        {item.body}
      </div>
    </>
  );
}
