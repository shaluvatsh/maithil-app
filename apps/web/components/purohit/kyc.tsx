'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { ApplicationStatus } from './application-status';
import { ProfilePhoto } from './photo';

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
export type KycStatus =
  | 'pending' | 'submitted' | 'verified' | 'rejected' | 'expired' | 'changes_requested';

export interface KycDocument {
  id: string;
  kind: 'identity' | 'address' | 'pan' | 'qualification' | 'bank' | 'credential' | 'demo';
  status: string;
  last4: string | null;
  notes: string | null;
}

export type QualificationLevel =
  | '10th' | '12th' | 'diploma' | 'graduate' | 'post_graduate' | 'doctorate' | 'pathshala';

/** Where the application stands, in the words the tracker shows. */
export type KycStage =
  | 'collecting' | 'ready_to_submit' | 'in_review' | 'action_needed'
  | 'approved' | 'declined';

export interface KycState {
  status: KycStatus;
  stage: KycStage;
  /** Documents the reviewer has asked for again, each with their reason. */
  flagged: Array<{ id: string; kind: string; reason: string | null }>;
  /** How long review takes, so the screen and the message quote the same number. */
  reviewTargetHours: number;
  verifiedAt: string | null;
  highestQualification: QualificationLevel | null;
  documents: KycDocument[];
  /** Named by the API, so this screen never has to work out what is outstanding. */
  required: string[];
  missing: string[];
  needsQualification: boolean;
  /** Devotees see this before they book. Required, so it is reported like the rest. */
  needsPhoto: boolean;
  photoUrl: string | null;
  canSubmit: boolean;
}

/**
 * `pathshala` sits alongside the academic ladder rather than under it.
 *
 * A Veda pathshala Shastri or Acharya may hold no board certificate at all, and a
 * list that forced them to answer "10th" would understate exactly the training that
 * matters most in this work. Every option names a certificate that exists, because
 * choosing one obliges the purohit to upload it.
 */
export const QUALIFICATIONS: Array<{ id: QualificationLevel; label: string }> = [
  { id: '10th', label: 'Class 10' },
  { id: '12th', label: 'Class 12' },
  { id: 'diploma', label: 'Diploma' },
  { id: 'graduate', label: 'Graduate' },
  { id: 'post_graduate', label: 'Post-graduate' },
  { id: 'doctorate', label: 'Doctorate' },
  { id: 'pathshala', label: 'Pathshala (Shastri / Acharya)' },
];

const KINDS = [
  {
    id: 'identity' as const,
    title: 'Photo ID',
    blurb: 'Aadhaar, PAN, voter card or passport. Required.',
    asksLast4: true,
  },
  {
    id: 'address' as const,
    title: 'Proof of address',
    blurb: 'A utility bill, rent agreement, passport or Aadhaar. Required.',
    asksLast4: false,
  },
  {
    id: 'pan' as const,
    title: 'PAN card',
    blurb: 'Required — we cannot pay you without it.',
    asksLast4: true,
  },
  {
    id: 'qualification' as const,
    title: 'Your qualification certificate',
    blurb: 'The certificate for the qualification you chose above. Required.',
    asksLast4: false,
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

/** How each outstanding item is named back to the purohit. */
const MISSING_LABEL: Record<string, string> = {
  identity: 'a photo ID',
  address: 'proof of address',
  pan: 'your PAN card',
  qualification: 'your qualification certificate',
};

const LABEL: Record<KycStatus, { text: string; tone: string }> = {
  pending: { text: 'Not started', tone: 'quiet' },
  submitted: { text: 'With our team', tone: 'ok' },
  changes_requested: { text: 'Needs your reply', tone: 'err' },
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
      /*
       * This carried `&& !signed.url.startsWith('memory://')` to tolerate the
       * development store. It could never run: the dev store handed out a
       * `memory://` URL, and `fetch` REJECTS on an unknown scheme rather than
       * returning a failed response — so the throw happened above this line and
       * every local upload died on "Failed to fetch". The dev store serves real
       * HTTP now, so there is one path here and it is the production one.
       */
      if (!put.ok) {
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

  /*
   * A flagged document is not "Received".
   *
   * It showed a green tick and the word Received even after the reviewer had asked
   * for it again — so the one tile the purohit had to act on looked exactly like the
   * three that were finished, and the upload control was hidden behind it. It has to
   * read as outstanding, and it has to be replaceable in place.
   */
  const flagged = existing?.status === 'rejected';

  return (
    <div className={`kyc-doc${existing && !flagged ? ' done' : ''}${flagged ? ' flagged' : ''}`}>
      <div className="kyc-doc-say">
        <strong>{kind.title}</strong>
        <span className="muted">{kind.blurb}</span>
        {existing?.notes && <span className="kyc-note">{existing.notes}</span>}
      </div>

      {existing && !flagged ? (
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

  const setQualification = async (level: QualificationLevel) => {
    setBusy(true); setErr(null);
    try {
      await api('/v1/me/purohit/kyc/qualification', {
        method: 'POST', body: JSON.stringify({ level }),
      });
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

      <ApplicationStatus stage={state.stage} reviewTargetHours={state.reviewTargetHours} />

      {/*
        What the reviewer actually asked for, in their words.
        A flagged document still EXISTS, so it never appears in "still needed" — the
        purohit has to be told separately which one to replace and why, or they send
        the same photograph again.
      */}
      {state.flagged.length > 0 && (
        <div className="notice err kyc-asked">
          <strong>Please send {state.flagged.length === 1 ? 'this again' : 'these again'}:</strong>
          <ul>
            {state.flagged.map((f) => (
              <li key={f.id}>
                <b>{MISSING_LABEL[f.kind] ?? f.kind}</b>
                {f.reason ? ` — ${f.reason}` : ''}
              </li>
            ))}
          </ul>
          <span className="muted">
            Replace only what is listed here. Everything else you sent is fine.
          </span>
        </div>
      )}

      <p className="muted">
        {/*
          * The waiting state is stated ONCE, by the screen above this panel, which
          * says it first and larger. Repeating it here put the same two sentences on
          * the page twice, a few centimetres apart.
          */}
        {state.status === 'submitted'
          ? 'You can still replace a document while we are checking.'
          : 'Devotees only see purohits we have checked. We need your ID, your '
            + 'address, your PAN and proof of your highest qualification — a '
            + 'recording and a lineage letter are optional, and they are what make '
            + 'a family choose you.'}
      </p>

      {/*
        * The photograph leads, because it is the only thing about this application a
        * devotee will ever see. Everything below it is for the reviewer.
        */}
      <ProfilePhoto photoUrl={state.photoUrl} onChanged={() => void load()} />

      {/*
        * Chosen BEFORE the certificate is uploaded, so the two cannot disagree about
        * what is being shown — a reviewer opening a degree scan needs to know what it
        * is meant to prove. It also outlives the image, which is purged 30 days after
        * a decision.
        */}
      <div className="kyc-qual">
        <label htmlFor="qual"><strong>Your highest qualification</strong></label>
        <select id="qual" value={state.highestQualification ?? ''} disabled={busy}
                onChange={(e) => void setQualification(e.target.value as QualificationLevel)}>
          <option value="" disabled>Choose one…</option>
          {QUALIFICATIONS.map((q) => (
            <option key={q.id} value={q.id}>{q.label}</option>
          ))}
        </select>
      </div>

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
        <button className="btn" disabled={busy || !state.canSubmit} onClick={() => void submit()}>
          {busy ? 'Sending…' : 'Send for review'}
        </button>
      )}
      {/*
        * Names what is outstanding. "Your application is incomplete" leaves someone
        * scrolling four upload tiles to work out which one it means — and the API
        * already tells us, so the screen never has to guess.
        */}
      {!state.canSubmit && state.status !== 'submitted' && (
        (() => {
          /*
           * Only what is genuinely outstanding. When the sole blocker is a flagged
           * document the list is empty, and this rendered the bare string
           * "Still needed: ." — the panel above already names what to replace.
           */
          const outstanding = [
            ...(state.needsPhoto ? ['a photo of yourself'] : []),
            ...(state.needsQualification ? ['your highest qualification'] : []),
            ...state.missing.map((m) => MISSING_LABEL[m] ?? m),
          ];
          if (outstanding.length === 0) return null;
          return (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Still needed: {outstanding.join(', ')}.
            </p>
          );
        })()
      )}
    </section>
  );
}
