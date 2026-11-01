'use client';
import type { ReactNode } from 'react';

/**
 * One labelled form field.
 *
 * THE BUG THIS EXISTS TO FIX, which shipped in three forms before anyone noticed.
 * Every field was written as a wrapping label with the hint inside it:
 *
 *     <label>Title <input/> <span>0/160</span></label>
 *
 * A wrapping `<label>` takes its whole text content as the field's accessible NAME, so
 * that input is called "Title 0/160" — and because the counter changes on every
 * keystroke, **the field is renamed as you type**. A screen-reader user hears the
 * counter as part of the field's identity and hears it again on every character.
 *
 * The hint belongs in `aria-describedby`: announced after the name, allowed to change,
 * and skippable. So the label is explicit (`htmlFor`) and the hint is a sibling.
 *
 * ONE OWNER, on purpose. The same pattern was written out in `community/ask`,
 * `events/new` and `learn/new`, which is three places to get it wrong and three
 * places that would each have to be found again. A shared component is the same
 * argument `packages/region` makes about values, applied to markup.
 *
 * Callers must put `id` on the control and `aria-describedby={`${id}-hint`}` when they
 * pass a hint — this cannot do it for them without cloning children, which would
 * break every typed prop on the input.
 */
export function Field({
  id, label, hint, children,
}: {
  id: string;
  label: string;
  /** Helper text or a counter. Announced as a description, never as the name. */
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span id={`${id}-hint`} className="field-hint muted">{hint}</span>}
    </div>
  );
}
