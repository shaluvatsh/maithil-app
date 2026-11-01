'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';

/**
 * Starts a password reset.
 *
 * This screen must look and behave IDENTICALLY whether or not the email it is
 * given belongs to an account — the API already guarantees that (see
 * `AuthService.requestPasswordReset`'s own note on why an endpoint that answers
 * differently is an account-existence oracle wearing a "forgot password" label),
 * and a client that branched on the response here would quietly reopen exactly
 * that hole. There is only ever one success state to show.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api('/v1/auth/password-reset/request', {
        method: 'POST', auth: false, body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch (e) {
      // Only a genuinely unusable request reaches here — malformed email, or the
      // per-address rate limit. Neither reveals whether the account exists.
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-split">
      <aside className="auth-aside">
        <h2>Your ritual, done right.</h2>
        <p className="lede">
          Verified pandits, a real time slot you can hold, and a price that is itemised
          before you pay.
        </p>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          {sent ? (
            <>
              <h1>Check your email</h1>
              <p className="sub">
                If an account exists for {email.trim()}, we have sent a link to
                reset its password. It works for 30 minutes.
              </p>
              <div className="notice quiet">
                Nothing arriving? Check spam, or confirm you signed up with this
                exact address — we do not say which, on purpose.
              </div>
              <p className="auth-alt">
                <Link className="btn-link" href="/login">Back to sign in</Link>
              </p>
            </>
          ) : (
            <>
              <h1>Forgot your password?</h1>
              <p className="sub">
                Enter the email on your account and we will send you a link to
                choose a new password.
              </p>

              {err && <div className="notice err">{err}</div>}

              <div className="field">
                <label htmlFor="email">Email address</label>
                <input id="email" type="email" autoComplete="email" autoFocus
                       value={email} onChange={(e) => setEmail(e.target.value)}
                       placeholder="you@example.com"
                       onKeyDown={(e) => e.key === 'Enter' && emailOk && !busy && submit()} />
              </div>

              <button className="btn-block" disabled={busy || !emailOk} onClick={submit}>
                {busy ? 'Sending…' : 'Send reset link'}
              </button>

              <p className="auth-alt">
                Remembered it, or would rather use your phone number?{' '}
                <Link className="btn-link" href="/login">Sign in</Link>
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
