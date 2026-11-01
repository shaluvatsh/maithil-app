'use client';

import { useRef, useState } from 'react';
import { api } from '@/lib/api';

/**
 * The purohit's own photograph.
 *
 * The booking screen rendered the first letter of their name in a circle, and
 * `photoUrl` had been on the search contract since the first commit with `null`
 * hardcoded into it. Since ADR 0012 the platform ASSIGNS the purohit, so the family
 * did not choose this person and meets them for the first time at their own door —
 * a letter in a circle was the whole of what they had beforehand.
 *
 * Separate from the KYC document tiles on purpose. This one is public and permanent;
 * those are private and deleted thirty days after a decision.
 */
export function ProfilePhoto({
  photoUrl, onChanged,
}: {
  photoUrl: string | null;
  onChanged: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Shown immediately, so the purohit sees their photo before the round trip ends. */
  const [preview, setPreview] = useState<string | null>(null);

  const choose = async (file: File) => {
    setBusy(true); setErr(null);
    setPreview(URL.createObjectURL(file));
    try {
      const signed = await api<{ url: string; key: string }>(
        '/v1/me/purohit/photo/upload-url',
        { method: 'POST', body: JSON.stringify({ contentType: file.type }) },
      );
      // Straight to storage, carrying no bearer token — same as the KYC path.
      const put = await fetch(signed.url, {
        method: 'PUT', headers: { 'content-type': file.type }, body: file,
      });
      if (!put.ok) throw new Error('the upload did not complete — please try again');

      await api('/v1/me/purohit/photo', {
        method: 'POST', body: JSON.stringify({ photoKey: signed.key }),
      });
      onChanged();
    } catch (e) {
      setPreview(null);
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  const shown = preview ?? photoUrl;

  return (
    <div className="ppic">
      <div className="ppic-face">
        {shown
          // Their own photo, so no alt text describing it back to them.
          ? <img src={shown} alt="" />
          : <span aria-hidden="true">☺</span>}
      </div>

      <div className="ppic-say">
        <strong>Your photo</strong>
        <span className="muted">
          Devotees see this before they book you. A clear photo of your face, in good
          light — not a group photo, and not a deity.
        </span>
        {err && <span className="ppic-err">{err}</span>}
      </div>

      {/*
        `accept="image/*"` with no `capture` on purpose: on a phone this offers both
        the camera and the gallery, so a purohit can take one now or pick one they
        already have. Forcing `capture` would take the second away.
      */}
      <input
        ref={input} type="file" accept="image/jpeg,image/png" hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void choose(f);
        }} />
      <button className="btn outline sm" disabled={busy}
              onClick={() => input.current?.click()}>
        {busy ? 'Uploading…' : shown ? 'Change' : 'Add photo'}
      </button>
    </div>
  );
}
