'use client';
import { Suspense, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, auth } from '@/lib/api';

type Mode = 'otp' | 'password';

interface AuthResponse {
  // `refreshToken` was missing from this type, so the field the API actually
  // returns was invisible — the session silently capped at 15 minutes and
  // typecheck had nothing to complain about.
  tokens: { accessToken: string; refreshToken: string };
  user: { id: string; role: string; name: string | null; phone: string };
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/book';

  const [mode, setMode] = useState<Mode>('otp');
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // OTP
  const [phone, setPhone] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const boxes = useRef<Array<HTMLInputElement | null>>([]);

  // Password
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pwPhone, setPwPhone] = useState('');
  const [password, setPassword] = useState('');
  /**
   * Registering as a purohit was impossible — the endpoint hardcoded
   * `role: 'devotee'`, so the only purohits that ever existed came from
   * `db:seed:dev`. Supply could not onboard itself.
   */
  const [role, setRole] = useState<'devotee' | 'pandit'>('devotee');

  const done = (res: AuthResponse) => {
    // The refresh token was being dropped on the floor here, which capped every
    // session at the 15-minute access-token lifetime.
    auth.set(
      res.tokens.accessToken,
      res.user.role,
      res.user.name ?? res.user.phone,
      res.tokens.refreshToken,
    );
    router.push(res.user.role === 'pandit' ? '/purohit' : next);
  };

  const run = async (fn: () => Promise<AuthResponse | void>) => {
    setBusy(true); setErr(null);
    try { const r = await fn(); if (r) done(r); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const sendOtp = () => run(async () => {
    const r = await api<{ requestId: string; devOtp?: string }>('/v1/auth/otp/request', {
      method: 'POST', auth: false, body: JSON.stringify({ phone }),
    });
    setRequestId(r.requestId);
    if (r.devOtp) {
      setDigits(r.devOtp.split(''));
    } else {
      setDigits(Array(6).fill(''));
      setTimeout(() => boxes.current[0]?.focus(), 40);
    }
  });

  const verifyOtp = () => run(() => api<AuthResponse>('/v1/auth/otp/verify', {
    method: 'POST', auth: false,
    body: JSON.stringify({ requestId, phone, otp: digits.join('') }),
  }));

  const submitPassword = () => run(() => register
    ? api<AuthResponse>('/v1/auth/register', {
        method: 'POST', auth: false,
        body: JSON.stringify({ name, email, phone: pwPhone, password, role }),
      })
    : api<AuthResponse>('/v1/auth/login', {
        method: 'POST', auth: false, body: JSON.stringify({ email, password }),
      }));

  const setDigit = (i: number, v: string) => {
    const clean = v.replace(/\D/g, '');
    if (clean.length > 1) {                       // paste of a whole code
      const spread = clean.slice(0, 6).split('');
      setDigits(Array.from({ length: 6 }, (_, k) => spread[k] ?? ''));
      boxes.current[Math.min(spread.length, 5)]?.focus();
      return;
    }
    const nextDigits = [...digits];
    nextDigits[i] = clean;
    setDigits(nextDigits);
    if (clean && i < 5) boxes.current[i + 1]?.focus();
  };

  const phoneOk = phone.replace(/\D/g, '').length >= 10;
  const otpOk = digits.every((d) => d !== '');

  return (
    <div className="auth-split">
      <aside className="auth-aside">
        <h2>Your ritual, done right.</h2>
        <p className="lede">
          Verified pandits, a real time slot you can hold, and a price that is itemised
          before you pay.
        </p>
        <ul>
          <li><span className="ic">✓</span><div>
            <b>Verified pandits</b><span>Credentials and background checked before they are listed.</span>
          </div></li>
          <li><span className="ic">📅</span><div>
            <b>Real availability</b><span>Pick an open slot. No waiting 24 hours to be allocated.</span>
          </div></li>
          <li><span className="ic">₹</span><div>
            <b>Transparent pricing</b><span>Dakshina, samagri and fees on separate lines.</span>
          </div></li>
          <li><span className="ic">🔒</span><div>
            <b>Protected bookings</b><span>Full refund if we cannot send the pandit we promised.</span>
          </div></li>
        </ul>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <h1>{register ? 'Create your account' : 'Welcome back'}</h1>
          <p className="sub">
            {register
              ? 'A few details and you can book in under a minute.'
              : 'Sign in to book a pandit and track your ceremonies.'}
          </p>

          {!register && (
            <div className="tabs">
              <button className={mode === 'otp' ? 'on' : ''}
                      onClick={() => { setMode('otp'); setErr(null); }}>Phone OTP</button>
              <button className={mode === 'password' ? 'on' : ''}
                      onClick={() => { setMode('password'); setErr(null); }}>Email &amp; password</button>
            </div>
          )}

          {err && <div className="notice err">{err}</div>}

          {!register && mode === 'otp' && (
            <>
              <div className="field with-prefix">
                <label htmlFor="phone">Mobile number</label>
                <span className="prefix">+91</span>
                <input id="phone" inputMode="numeric" autoComplete="tel" maxLength={10}
                       value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                       placeholder="98300 12345"
                       onKeyDown={(e) => e.key === 'Enter' && phoneOk && !requestId && sendOtp()} />
              </div>

              {!requestId ? (
                <button className="btn-block" disabled={busy || !phoneOk} onClick={sendOtp}>
                  {busy ? 'Sending…' : 'Send OTP'}
                </button>
              ) : (
                <>
                  <div className="field">
                    <label>Enter the 6-digit code</label>
                    <div className="otp-boxes">
                      {digits.map((d, i) => (
                        <input key={i} ref={(el) => { boxes.current[i] = el; }}
                               inputMode="numeric" maxLength={6} value={d}
                               onChange={(e) => setDigit(i, e.target.value)}
                               onKeyDown={(e) => {
                                 if (e.key === 'Backspace' && !digits[i] && i > 0) boxes.current[i - 1]?.focus();
                                 if (e.key === 'Enter' && otpOk) verifyOtp();
                               }} />
                      ))}
                    </div>
                    <div className="hint">Sent to +91 {phone}. <button className="btn"
                      style={{ background: 'none', border: 0, color: 'var(--orange-600)', fontWeight: 700, padding: 0 }}
                      onClick={() => { setRequestId(null); setDigits(Array(6).fill('')); }}>Change number</button></div>
                  </div>
                  <button className="btn-block" disabled={busy || !otpOk} onClick={verifyOtp}>
                    {busy ? 'Verifying…' : 'Verify & continue'}
                  </button>
                  <div className="auth-alt">
                    Didn&apos;t get it? <button className="btn-link" onClick={sendOtp} disabled={busy}>Resend OTP</button>
                  </div>
                </>
              )}
            </>
          )}

          {(register || mode === 'password') && (
            <>
              {register && (
                <>
                  {/* Two-sided marketplace, one signup. Without this a purohit
                      had no way into the product at all. */}
                  <div className="field">
                    <label>I am</label>
                    <div className="opt-row">
                      <button type="button"
                              className={`opt ${role === 'devotee' ? 'on' : ''}`}
                              aria-pressed={role === 'devotee'}
                              onClick={() => setRole('devotee')}>
                        Booking a pooja
                        <span className="s">I want a pandit for a ceremony</span>
                      </button>
                      <button type="button"
                              className={`opt ${role === 'pandit' ? 'on' : ''}`}
                              aria-pressed={role === 'pandit'}
                              onClick={() => setRole('pandit')}>
                        A pandit
                        <span className="s">I perform ceremonies and want work</span>
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="name">Full name</label>
                    <input id="name" autoComplete="name" value={name}
                           onChange={(e) => setName(e.target.value)} placeholder="Your name" />
                  </div>
                  <div className="field with-prefix">
                    <label htmlFor="rphone">Mobile number</label>
                    <span className="prefix">+91</span>
                    <input id="rphone" inputMode="numeric" autoComplete="tel" maxLength={10}
                           value={pwPhone} onChange={(e) => setPwPhone(e.target.value.replace(/\D/g, ''))}
                           placeholder="98300 12345" />
                    <div className="hint">The pandit uses this to reach you on the day.</div>
                  </div>
                </>
              )}
              <div className="field">
                <label htmlFor="email">Email address</label>
                <input id="email" type="email" autoComplete="email" value={email}
                       onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <div className="field">
                <label htmlFor="pw">Password</label>
                <input id="pw" type="password" value={password}
                       autoComplete={register ? 'new-password' : 'current-password'}
                       onChange={(e) => setPassword(e.target.value)}
                       placeholder={register ? 'At least 8 characters' : 'Your password'}
                       onKeyDown={(e) => e.key === 'Enter' && submitPassword()} />
                {register && <div className="hint">Length matters more than symbols. A short phrase works well.</div>}
              </div>
              <button className="btn-block" disabled={busy || !email || !password} onClick={submitPassword}>
                {busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}
              </button>
            </>
          )}

          <div className="auth-alt">
            {register ? (
              <>Already have an account?{' '}
                <button className="btn-link" onClick={() => { setRegister(false); setErr(null); }}>Sign in</button></>
            ) : (
              <>New to TheMaithil?{' '}
                <button className="btn-link" onClick={() => { setRegister(true); setMode('password'); setErr(null); }}>
                  Create an account
                </button></>
            )}
          </div>

          <div className="demo-note">
            <strong>Demo accounts.</strong> Devotee <code>9830012345</code>, pandits{' '}
            <code>9830000101/102/103</code>. In development the OTP is filled in for you.
          </div>

          <p className="auth-legal">
            By continuing you agree to our Terms of Service and Privacy Policy.{' '}
            <Link href="/">Back to home</Link>
          </p>
        </div>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense fallback={null}><LoginInner /></Suspense>;
}
