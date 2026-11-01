'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Where a purohit's money goes.
 *
 * `linked_account_id` had existed since the payments client was written and nothing
 * ever set it, because nothing ever asked. Payouts computed a correct net payable
 * with no destination while the earnings screen promised weekly payouts — the
 * platform could take a devotee's money and had no way to pay the person who did the
 * work.
 *
 * Used in two places, deliberately the same component: as a step in onboarding, and
 * as an editable panel on the dashboard. A purohit changes bank accounts; a form
 * that exists only inside a wizard they have already finished is a support ticket.
 */
export interface PayoutAccount {
  linked: boolean;
  method: 'bank_account' | 'upi' | null;
  holderName: string | null;
  last4: string | null;
  ifsc: string | null;
  upiVpa: string | null;
  linkedAt: string | null;
}

/** What the purohit reads back once it is saved. Never an account number. */
export function describeAccount(a: PayoutAccount): string {
  if (!a.linked) return 'No payout account yet';
  if (a.method === 'upi') return a.upiVpa ?? 'UPI';
  return `Account ending ${a.last4 ?? '••••'} · ${a.ifsc ?? ''}`.trim();
}

export function PayoutAccountForm({
  account, onSaved, compact,
}: {
  account: PayoutAccount | null;
  onSaved: (a: PayoutAccount) => void;
  /** Inside the wizard the heading comes from the step, not from here. */
  compact?: boolean;
}) {
  const [method, setMethod] = useState<'bank_account' | 'upi'>('bank_account');
  const [holderName, setHolderName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [vpa, setVpa] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (account?.holderName) setHolderName(account.holderName);
    if (account?.method) setMethod(account.method);
  }, [account]);

  /*
   * Both numbers are compared here as well as on the server. Not duplicated
   * validation for its own sake — the server is the one that counts — but the
   * mismatch is worth catching before a network round trip, because the purohit
   * still has both values on screen and in mind.
   */
  const mismatch = accountNumber.length > 0 && confirm.length > 0
    && accountNumber !== confirm;

  const ready = method === 'bank_account'
    ? holderName.trim().length >= 2 && /^\d{9,18}$/.test(accountNumber)
      && !mismatch && confirm.length > 0 && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc.toUpperCase())
    : holderName.trim().length >= 2 && /^[\w.\-]{2,64}@[a-zA-Z]{2,64}$/.test(vpa);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = method === 'bank_account'
        ? { method, holderName, accountNumber, accountNumberConfirm: confirm, ifsc }
        : { method, holderName, vpa };
      await api('/v1/me/purohit/payout-account', {
        method: 'PUT', body: JSON.stringify(body),
      });
      const fresh = await api<PayoutAccount>('/v1/me/purohit/payout-account');
      // Cleared rather than left in the DOM: there is no reason for an account
      // number to still be sitting in a form after it has been sent.
      setAccountNumber(''); setConfirm('');
      setEditing(false);
      onSaved(fresh);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (account?.linked && !editing) {
    return (
      <div className="payout-done">
        <div>
          <span className="muted" style={{ fontSize: 12 }}>Payouts go to</span>
          <div className="payout-ref">{describeAccount(account)}</div>
          <div className="muted" style={{ fontSize: 12 }}>{account.holderName}</div>
        </div>
        <button className="btn outline sm" onClick={() => setEditing(true)}>Change</button>
      </div>
    );
  }

  return (
    <div className="payout-form">
      {!compact && <h2 style={{ marginTop: 0 }}>Where should we send your money?</h2>}

      <div className="pickgrid">
        <button type="button" className={`opt${method === 'bank_account' ? ' on' : ''}`}
                aria-pressed={method === 'bank_account'}
                onClick={() => setMethod('bank_account')}>
          Bank account<span className="s">Any Indian bank</span>
        </button>
        <button type="button" className={`opt${method === 'upi' ? ' on' : ''}`}
                aria-pressed={method === 'upi'}
                onClick={() => setMethod('upi')}>
          UPI<span className="s">GPay, PhonePe, Paytm</span>
        </button>
      </div>

      <div className="field">
        <label htmlFor="pa-name">Name on the account</label>
        <input id="pa-name" value={holderName} maxLength={120}
               autoComplete="name"
               onChange={(e) => setHolderName(e.target.value)} />
      </div>

      {method === 'bank_account' ? (
        <>
          <div className="field">
            <label htmlFor="pa-num">Account number</label>
            <input id="pa-num" inputMode="numeric" className="mono" value={accountNumber}
                   autoComplete="off" maxLength={18}
                   onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ''))} />
          </div>
          <div className="field">
            <label htmlFor="pa-num2">Type it again</label>
            <input id="pa-num2" inputMode="numeric" className="mono" value={confirm}
                   autoComplete="off" maxLength={18}
                   onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))} />
            {/* There is no checksum in an account number. One wrong digit sends the
                money to a stranger, and nothing can pull it back. */}
            {mismatch && (
              <p className="field-err">These do not match. Money sent to the wrong
                account cannot be recovered, so please check both.</p>
            )}
          </div>
          <div className="field">
            <label htmlFor="pa-ifsc">IFSC</label>
            <input id="pa-ifsc" className="mono" value={ifsc} maxLength={11}
                   placeholder="HDFC0001234" autoComplete="off"
                   onChange={(e) => setIfsc(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
            <p className="muted" style={{ fontSize: 12 }}>
              Printed on your cheque book and in your banking app.
            </p>
          </div>
        </>
      ) : (
        <div className="field">
          <label htmlFor="pa-vpa">Your UPI id</label>
          <input id="pa-vpa" className="mono" value={vpa} maxLength={64}
                 placeholder="yourname@okaxis" autoComplete="off"
                 onChange={(e) => setVpa(e.target.value.trim())} />
        </div>
      )}

      {err && <div className="notice err">{err}</div>}

      <p className="muted" style={{ fontSize: 12 }}>
        We pass these details straight to our payments partner and keep only the last
        four digits, so we can show you which account this is. We never store the
        full number.
      </p>

      <div className="row">
        {account?.linked && (
          <button className="btn outline" onClick={() => setEditing(false)}>Cancel</button>
        )}
        <button className="btn" disabled={busy || !ready} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save payout account'}
        </button>
      </div>
    </div>
  );
}

/**
 * The dashboard's version: silent once an account exists, unmissable until then.
 *
 * A purohit who completes jobs and cannot be paid will not chase this on their own —
 * they will assume it is coming, and find out on payout day.
 */
/**
 * Opens as a banner, not a form.
 *
 * This used to render the whole bank/UPI form inline, unprompted, above the job
 * list — a purohit signing in to see today's work met four empty text inputs
 * first, and on a phone that was the entire opening screen. Adding a payout
 * account is a once-ever task; reading the job inbox is why they came back today,
 * and the once-ever task was outranking it every single visit.
 *
 * Still impossible to miss (it is the only warm block on the page) and still not
 * dismissible while unlinked — money genuinely cannot move without it, so hiding
 * it for good would be worse. It just no longer opens itself.
 */
export function PayoutAccountPanel() {
  const [account, setAccount] = useState<PayoutAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api<PayoutAccount>('/v1/me/purohit/payout-account')
      .then(setAccount).catch(() => setAccount(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;

  const linked = Boolean(account?.linked);

  // Settled: a quiet line stating where the money goes, expandable to change it.
  if (linked && !open) {
    return (
      <section className="payout-banner">
        <div>
          <strong>Payouts go to</strong>
          <span className="muted"> {describeAccount(account!)}</span>
        </div>
        <button className="btn outline sm" onClick={() => setOpen(true)}>Change</button>
      </section>
    );
  }

  if (!linked && !open) {
    return (
      <section className="payout-banner warn">
        <div>
          <strong>We cannot pay you yet</strong>
          <span className="muted">
            {' '}Add a bank account or UPI id. What you earn stays on your balance until
            you do — nothing is lost, but nothing can be sent either.
          </span>
        </div>
        <button className="btn sm" onClick={() => setOpen(true)}>Add account</button>
      </section>
    );
  }

  return (
    <section className={linked ? 'card payout-card' : 'card payout-card warn'}>
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{linked ? 'Where you get paid' : 'We cannot pay you yet'}</h2>
        <button className="btn outline sm" onClick={() => setOpen(false)}>Close</button>
      </div>
      <PayoutAccountForm
        account={account}
        onSaved={(a) => { setAccount(a); setOpen(false); }}
        compact={!linked}
      />
    </section>
  );
}
