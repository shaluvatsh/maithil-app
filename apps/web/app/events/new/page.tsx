'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRegion } from '@/lib/region-context';
import { Field } from '@/components/field';
import { auth, api } from '@/lib/api';
import { languagesFor, slotInstant } from '@themaithil/region';
import { EventKind, type ContentLocale, type PanjikaSchool } from '@themaithil/contracts';

/**
 * Listing an event.
 *
 * Anyone signed in may list something; only a verified purohit may ever take money
 * for a place. The form therefore does not offer a paid mode at all — the service
 * refuses it and the database refuses it again, and a control that exists only to be
 * rejected teaches people the product is broken. The reason is stated instead.
 *
 * TIMES ARE THE CITY'S, not the device's. `<input type="datetime-local">` is
 * interpreted in whatever timezone the phone is set to, so a purohit travelling, or
 * anyone whose phone is on the wrong zone, would list a 6am tarpan at some other
 * hour. `slotInstant` builds the instant from the REGION's offset — the same
 * function availability uses, and the reason it exists (Nepal is +05:45).
 */
export default function HostEventPage() {
  const { t, region, locale: uiLocale } = useRegion();
  const router = useRouter();

  const [signedIn, setSignedIn] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => { setSignedIn(Boolean(auth.token)); setRole(auth.role); }, []);

  const [kind, setKind] = useState<string>('kirtan');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [locale, setLocale] = useState<ContentLocale>(uiLocale as ContentLocale);
  const [venueName, setVenueName] = useState('');
  const [venueLine1, setVenueLine1] = useState('');
  const [pincode, setPincode] = useState('');
  const [date, setDate] = useState('');
  const [start, setStart] = useState('18:00');
  const [end, setEnd] = useState('20:00');
  const [school, setSchool] = useState('');
  const [mode, setMode] = useState<'none' | 'rsvp'>('none');
  const [capacity, setCapacity] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // The stored language preference arrives after mount, so the field follows it.
  useEffect(() => { setLocale(uiLocale as ContentLocale); }, [uiLocale]);

  useEffect(() => {
    if (!auth.token) router.replace('/login?next=/events/new');
  }, [router]);

  const ready = title.trim().length >= 6 && description.trim().length >= 20
    && venueName.trim().length >= 2 && venueLine1.trim().length >= 3 && date !== '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const startAt = slotInstant(date, start, region).toISOString();
      const endAt = slotInstant(date, end, region).toISOString();
      const cap = capacity.trim() === '' ? null : Number(capacity);

      const created = await api<{ id: string }>('/v1/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind, title: title.trim(), description: description.trim(), locale,
          citySlug: region.slug,
          venueName: venueName.trim(), venueLine1: venueLine1.trim(),
          ...(pincode.trim() ? { pincode: pincode.trim() } : {}),
          startAt, endAt,
          ...(school ? { panjikaSchool: school as PanjikaSchool } : {}),
          registrationMode: mode,
          ...(externalUrl.trim() ? { externalUrl: externalUrl.trim() } : {}),
          // One session spanning the event, with the capacity if one was given. The
          // service defaults to this anyway; sent explicitly so capacity can travel.
          sessions: [{ startAt, endAt, capacity: cap, pricePaise: 0 }],
        }),
      });

      /*
       * Created as a draft, then published, because they are two decisions. A listing
       * goes live at once; anything we stand behind goes to review instead, and the
       * response says which so the copy can be honest about it.
       */
      const published = await api<{ state: string }>(`/v1/events/${created.id}/publish`, {
        method: 'POST',
      });

      if (published.state === 'published') {
        router.push(`/events/${created.id}`);
        return;
      }
      setMsg(t('events.inReview'));
    } catch (x) {
      setMsg(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn) {
    return (
      <main className="wrap ev-wrap">
        <Link href="/login?next=/events/new" className="btn">{t('events.hostSignIn')}</Link>
      </main>
    );
  }

  return (
    <main className="wrap ev-wrap ev-host">
      <Link href="/events" className="btn-link ev-back">← {t('events.backToEvents')}</Link>
      <h1>{t('events.host')}</h1>
      <p className="muted ev-blurb">{t('events.hostBlurb')}</p>

      {/* Said up front, not discovered on the card afterwards. */}
      {role !== 'pandit' && <p className="ev-note">{t('events.hostDevoteeNote')}</p>}

      <form onSubmit={submit} className="ev-form">
        <Field id="ev-kind" label={t('events.fKind')}>
          <select id="ev-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {/* Straight from the contract enum, so a new kind needs no change here. */}
            {EventKind.options.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </Field>

        <Field id="ev-title" label={t('events.fTitle')}>
          <input id="ev-title" value={title} onChange={(e) => setTitle(e.target.value)} lang={locale} maxLength={180} />
        </Field>

        <Field id="ev-description" label={t('events.fDescription')}>
          <textarea id="ev-description"
            rows={5} value={description} lang={locale} maxLength={4000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <Field id="ev-language" label={t('events.fLanguage')}>
          <select id="ev-language" value={locale} onChange={(e) => setLocale(e.target.value as ContentLocale)}>
            {/* This city's languages first, then the rest — a migrant host writes in
                their own language wherever they live. */}
            {languagesFor(region.locales).map((l) => (
              <option key={l.code} value={l.code}>{l.native} — {l.en}</option>
            ))}
          </select>
        </Field>

        <Field id="ev-venuename" label={t('events.fVenueName')}>
          <input id="ev-venuename" value={venueName} onChange={(e) => setVenueName(e.target.value)} maxLength={160} />
        </Field>

        <Field id="ev-venueline" label={t('events.fVenueLine')}>
          <input id="ev-venueline" value={venueLine1} onChange={(e) => setVenueLine1(e.target.value)} maxLength={240} />
        </Field>

        <Field id="ev-pincode" label={t('events.fPincode')} hint={t('events.fPincodeWhy')}>
          <input id="ev-pincode" aria-describedby="ev-pincode-hint"
            value={pincode} onChange={(e) => setPincode(e.target.value)}
            inputMode="numeric" pattern="\d{6}" maxLength={6}
          />
          {/* Why it matters, rather than an asterisk: without it the card can only
              name the city, because the fallback coordinate is the city centroid. */}
        </Field>

        <Field id="ev-date" label={t('events.fDate')}>
          <input id="ev-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>

        <div className="ev-times">
          <Field id="ev-start" label={t('events.fStart')}>
            <input id="ev-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field id="ev-end" label={t('events.fEnd')}>
            <input id="ev-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <p className="muted cm-small">{t('events.fTimeWhy', { city: region.name.en })}</p>

        <Field id="ev-panjika" label={t('events.fPanjika')}>
          <select id="ev-panjika" value={school} onChange={(e) => setSchool(e.target.value)}>
            <option value="">{t('events.fPanjikaNone')}</option>
            {/* The almanacs this city keeps, in their own script. */}
            {region.panjikas.map((p) => (
              <option key={p.id} value={p.id}>{p.native} — {p.english}</option>
            ))}
          </select>
        </Field>

        <fieldset className="ev-modes">
          <legend>{t('events.fMode')}</legend>
          <label className="cm-radio">
            <input type="radio" name="mode" checked={mode === 'none'} onChange={() => setMode('none')} />
            {t('events.fModeNone')}
          </label>
          <label className="cm-radio">
            <input type="radio" name="mode" checked={mode === 'rsvp'} onChange={() => setMode('rsvp')} />
            {t('events.fModeRsvp')}
          </label>
          {/*
            * No paid option, deliberately. The service refuses it and the database
            * refuses it again; offering a control that only ever fails teaches people
            * the product is broken, so the reason is stated instead.
            */}
          <p className="muted cm-small">{t('events.fModeMoneyNote')}</p>
        </fieldset>

        {mode === 'rsvp' && (
          <Field id="ev-capacity" label={t('events.fCapacity')}>
            <input id="ev-capacity"
              value={capacity} onChange={(e) => setCapacity(e.target.value)}
              inputMode="numeric" pattern="\d*"
            />
          </Field>
        )}

        <Field id="ev-external" label={t('events.fExternal')}>
          <input id="ev-external" value={externalUrl} onChange={(e) => setExternalUrl(e.target.value)} type="url" />
        </Field>

        <button type="submit" className="btn" disabled={busy || !ready}>
          {t('events.publish')}
        </button>

        {msg && <p className="ev-notice">{msg}</p>}
      </form>
    </main>
  );
}
