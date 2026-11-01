'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';

function ResetPasswordInner() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Mirrors `passwordProblem`'s length rule (see apps/api — the common-password
  // check stays server-side only, same reasoning as the login page's own copy).
  const passwordOk = password.length >= 8;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api('/v1/auth/password-reset/confirm', {
        method: 'POST', auth: false, body: JSON.stringify({ token, password }),
      });
      setDone(true);
    } catch (e) {
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
          {!token ? (
            <>
              <h1>This link is incomplete</h1>
              <p className="sub">
                Open the link from the reset email again, or request a new one.
              </p>
              <Link className="btn-block" href="/forgot-password">
                Request a new link
              </Link>
            </>
          ) : done ? (
            <>
              <h1>Password changed</h1>
              <p className="sub">Sign in with your new password.</p>
              <Link className="btn-block" href="/login">
                Sign in
              </Link>
            </>
          ) : (
            <>
              <h1>Choose a new password</h1>
              <p className="sub">Make it at least 8 characters. A short phrase works well.</p>

              {err && (
                <div className="notice err">
                  {err}
                  {/* The one error this screen can get is an expired or already-used
                      link — the fix is always the same, so it is offered right here
                      rather than making them hunt for "forgot password" again. */}
                  {' '}<Link className="btn-link" href="/forgot-password">Request a new link</Link>
                </div>
              )}

              <div className="field with-reveal">
                <label htmlFor="pw">New password</label>
                <input id="pw" type={showPw ? 'text' : 'password'} value={password}
                       autoComplete="new-password" autoFocus
                       onChange={(e) => setPassword(e.target.value)}
                       placeholder="At least 8 characters"
                       onKeyDown={(e) => e.key === 'Enter' && passwordOk && !busy && submit()} />
                <button type="button" className="reveal"
                        aria-label={showPw ? 'Hide password' : 'Show password'}
                        onClick={() => setShowPw((v) => !v)}>
                  {showPw ? 'Hide' : 'Show'}
                </button>
              </div>

              <button className="btn-block" disabled={busy || !passwordOk} onClick={submit}>
                {busy ? 'Please wait…' : 'Set new password'}
              </button>

              <p className="auth-alt">
                <Link className="btn-link" href="/login">Back to sign in</Link>
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default function ResetPasswordPage() {
  return <Suspense fallback={null}><ResetPasswordInner /></Suspense>;
}
