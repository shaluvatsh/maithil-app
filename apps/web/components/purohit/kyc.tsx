'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Identity verification, from the purohit's side.
 *
 * Nothing in the product could create a `kyc_records` row before this existed. The
 * admin queue counted documents per purohit — a count that could only ever be zero —
 * and `kyc_status` could never reach `submitted`, so an admin approved people on the
 * strength of a name and a self-declared number of years. "Verified purohit" is the
 * central claim on the home page of a service that sends a stranger into a family's
 * home, and it meant an operator had clicked a button.
 *
 * The upload goes browser → storage directly, with a signed URL the API mints. The
 * file never passes through our servers.
 */
export type KycStatus = 'pending' | 'submitted' | 'verified' | 'rejected' | 'expired';

export interface KycDocument {
  id: string;
  kind: 'identity' | 'bank' | 'credential' | 'demo';
  status: string;
  last4: string | null;
  notes: string | null;
}

export interface KycState {
  status: KycStatus;
  verifiedAt: string | null;
  documents: KycDocument[];
  hasIdentity: boolean;
}

const KINDS = [
  {
    id: 'identity' as const,
    title: 'Photo ID',
    blurb: 'Aadhaar, PAN, voter card or passport. Required.',
    asksLast4: true,
  },
  {
    id: 'credential' as const,
    title: 'Training or lineage',
    blurb: 'A pathshala certificate or paramparā letter, if you have one.',
    asksLast4: false,
  },
  {
    /*
     * The credential no government database holds, and the one that actually
     * distinguishes a purohit. A family judging shuddha uchcharan cannot read a PAN
     * card; they can hear thirty seconds of chanting.
     */
    id: 'demo' as const,
    title: 'A recording of you performing',
    blurb: 'Optional, and the strongest thing you can give us.',
    asksLast4: false,
  },
];

const LABEL: Record<KycStatus, { text: string; tone: string }> = {
  pending: { text: 'Not started', tone: 'quiet' },
  submitted: { text: 'With our team', tone: 'ok' },
  verified: { text: 'Verified', tone: 'ok' },
  rejected: { text: 'Needs attention', tone: 'err' },
  expired: { text: 'Expired — please re-submit', tone: 'err' },
};

function DocumentRow({
  kind, existing, onAttached,
}: {
  kind: (typeof KINDS)[number];
  existing: KycDocument | undefined;
  onAttached: () => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [last4, setLast4] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const upload = async (chosen: File) => {
    setBusy(true); setErr(null);
    try {
      const signed = await api<{ url: string; key: string }>(
        '/v1/me/purohit/kyc/upload-url',
        { method: 'POST', body: JSON.stringify({ kind: kind.id, contentType: chosen.type }) },
      );

      /*
       * A bare `fetch`, not the project's `api()` helper.
       *
       * This request goes to object storage, not to our API: it must not carry the
       * bearer token, and the content type has to be exactly what was signed or the
       * signature will not verify.
       */
      const put = await fetch(signed.url, {
        method: 'PUT',
        headers: { 'content-type': chosen.type },
        body: chosen,
      });
      if (!put.ok && !signed.url.startsWith('memory://')) {
        throw new Error('the upload did not complete — please try again');
      }

      // Only after the bytes are stored. Signing a URL is not evidence that anything
      // was uploaded, which is why this is a second call.
      await api('/v1/me/purohit/kyc/documents', {
        method: 'POST',
        body: JSON.stringify({
          kind: kind.id, docKey: signed.key,
          ...(kind.asksLast4 && last4.length === 4 ? { identifierLast4: last4 } : {}),
        }),
      });
      onAttached();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className={existing ? 'kyc-doc done' : 'kyc-doc'}>
      <div className="kyc-doc-say">
        <strong>{kind.title}</strong>
        <span className="muted">{kind.blurb}</span>
        {existing?.notes && <span className="kyc-note">{existing.notes}</span>}
      </div>

      {existing ? (
        <span className="tag ok">Received</span>
      ) : (
        <div className="kyc-doc-act">
          {kind.asksLast4 && (
            <input
              className="mono" inputMode="numeric" maxLength={4} value={last4}
              aria-label="Last four digits of the document number"
              placeholder="last 4"
              style={{ width: 84 }}
              onChange={(e) => setLast4(e.target.value.replace(/\D/g, ''))}
            />
          )}
          <input
            ref={file} type="file" hidden
            accept="image/jpeg,image/png,application/pdf"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              if (chosen) void upload(chosen);
            }}
          />
          <button className="btn outline sm" disabled={busy}
                  onClick={() => file.current?.click()}>
            {busy ? 'Uploading…' : 'Choose file'}
          </button>
        </div>
      )}
      {err && <p className="field-err">{err}</p>}
    </div>
  );
}

export function KycPanel() {
  const [state, setState] = useState<KycState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api<KycState>('/v1/me/purohit/kyc')
    .then(setState).catch(() => setState(null));

  useEffect(() => { void load().finally(() => setLoading(false)); }, []);

  if (loading || !state) return null;

  // Nothing to say once they are through it. A verified purohit does not need a
  // standing reminder of a process that is finished.
  if (state.status === 'verified') return null;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api('/v1/me/purohit/kyc/submit', { method: 'POST' });
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const label = LABEL[state.status];

  return (
    <section className="card kyc-card">
      <div className="spread">
        <h2 style={{ marginTop: 0 }}>Getting you verified</h2>
        <span className={`tag ${label.tone}`}>{label.text}</span>
      </div>

      <p className="muted">
        {state.status === 'submitted'
          ? 'Your documents are with our team. We will message you when this is done — '
            + 'usually within two working days.'
          : 'Devotees only see purohits we have checked. A photo ID is all we need to '
            + 'start; everything else strengthens your profile.'}
      </p>

      <div className="kyc-docs">
        {KINDS.map((k) => (
          <DocumentRow
            key={k.id}
            kind={k}
            existing={state.documents.find((d) => d.kind === k.id)}
            onAttached={() => void load()}
          />
        ))}
      </div>

      {err && <div className="notice err">{err}</div>}

      {state.status !== 'submitted' && (
        <button className="btn" disabled={busy || !state.hasIdentity} onClick={() => void submit()}>
          {busy ? 'Sending…' : 'Send for review'}
        </button>
      )}
      {!state.hasIdentity && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          A photo ID is required before we can review your account.
        </p>
      )}
    </section>
  );
}
