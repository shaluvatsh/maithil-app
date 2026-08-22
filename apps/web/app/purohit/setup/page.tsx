'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, auth } from '@/lib/api';
import { useRegion } from '@/lib/region-context';
import { getRegion, languagesFor, TRADITIONS } from '@themaithil/region';
import { PayoutAccountForm, type PayoutAccount } from '@/components/purohit/payout-account';

/**
 * Purohit onboarding, as a wizard.
 *
 * The first version was three sections stacked on one long scroll, each with its
 * own save button — a settings page pretending to be onboarding. The persona in
 * DESIGN.md is 30–65, on a low-end Android, often one-handed and outdoors. That
 * person needs one decision per screen, large targets, and no ambiguity about
 * whether their work was kept.
 *
 * So: four steps, progress at the top, saved automatically on advance, and it ends
 * somewhere useful instead of on an empty job list.
 */
interface CatalogueRow {
  id: string; slug: string; bandMin: number; bandMax: number; bandDefault: number;
}
interface Profile {
  bio: string | null; experienceYears: number; languages: string[]; traditions: string[];
  serviceRadiusKm: number; baseLat: number | null; baseLng: number | null;
  kycStatus: string; cashJobsEnabled: boolean;
  chantingSampleUrl: string | null; chantingSampleLabel: string | null;
}

/*
 * Languages and traditions used to be two literals here — six English names, four
 * traditions, both of them Bengal's. A Chennai purohit could not record that they
 * conduct in Tamil, and search filters on an array overlap, so a language you cannot
 * record is a filter you can never match. Eight of the fourteen live cities could not
 * describe their own supply. Both lists now come from the region package, ordered by
 * the city being registered in. See packages/region/src/languages.ts.
 */
const RADII = [5, 10, 15, 25, 40];
/*
 * "Getting paid" sits immediately after rates, while the purohit is already thinking
 * about money, and before the calendar — which is the step that makes them bookable.
 * Asking for a bank account after they are already taking jobs is how a first payout
 * ends up stuck.
 */
const STEPS = ['About you', 'Your services', 'Your rates', 'Getting paid', 'Your calendar'];

const title = (slug: string) =>
  slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export default function PurohitSetup() {
  const router = useRouter();
  const { region, regions, money } = useRegion();

  const [at, setAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const [kyc, setKyc] = useState('pending');
  const [catalogue, setCatalogue] = useState<CatalogueRow[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [slotsOpen, setSlotsOpen] = useState<number | null>(null);
  const [payout, setPayout] = useState<PayoutAccount | null>(null);

  /** Empty rather than 0 — a zero in a "years" box looks like a rejected value. */
  const [years, setYears] = useState('');
  const [bio, setBio] = useState('');
  const [radius, setRadius] = useState(15);
  /**
   * Which city they work in. Registration files everyone under LAUNCH_CITY_SLUG and
   * nothing asked — so a Mumbai purohit was stored as Kolkata and invisible to every
   * Mumbai devotee. The search joins on city, so this is exclusion, not a penalty.
   */
  const [citySlug, setCitySlug] = useState(region.slug);
  const [chantUrl, setChantUrl] = useState('');
  const [chantLabel, setChantLabel] = useState('');
  const [languages, setLanguages] = useState<Set<string>>(new Set());
  const [traditions, setTraditions] = useState<Set<string>>(new Set(['smarta']));

  useEffect(() => {
    if (!auth.token) { router.replace('/login?next=/purohit/setup'); return; }
    api<{
      citySlug: string | null;
      profile: Profile | null;
      services: Array<{ ritualId: string; pricePaise: number; active: boolean }>;
      catalogue: CatalogueRow[];
    }>('/v1/me/purohit/profile')
      .then((r) => {
        setCatalogue(r.catalogue);
        setKyc(r.profile?.kycStatus ?? 'pending');
        if (r.citySlug) setCitySlug(r.citySlug);
        if (r.profile) {
          setYears(r.profile.experienceYears ? String(r.profile.experienceYears) : '');
          setBio(r.profile.bio ?? '');
          setRadius(r.profile.serviceRadiusKm || 15);
          setChantUrl(r.profile.chantingSampleUrl ?? '');
          setChantLabel(r.profile.chantingSampleLabel ?? '');
          if (r.profile.languages?.length) setLanguages(new Set(r.profile.languages));
          if (r.profile.traditions?.length) setTraditions(new Set(r.profile.traditions));
        }
        const active = r.services.filter((s) => s.active);
        setChosen(new Set(active.map((s) => s.ritualId)));
        setPrices(Object.fromEntries([
          ...r.catalogue.map((c) => [c.id, c.bandDefault]),
          ...active.map((s) => [s.ritualId, s.pricePaise]),
        ]));
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flip = (set: Set<string>, v: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v); else next.add(v);
    apply(next);
  };

  const picked = useMemo(
    () => catalogue.filter((c) => chosen.has(c.id)),
    [catalogue, chosen],
  );

  /**
   * The city's own languages first. Recomputed on city change, so a purohit who
   * corrects Kolkata to Chennai sees Tamil at the top rather than having to hunt for
   * it below six languages nobody in Chennai asked for.
   */
  const languageOptions = useMemo(
    () => languagesFor(getRegion(citySlug).locales),
    [citySlug],
  );

  /*
   * Seeded from the city rather than hardcoded to Bengali. An empty set would block
   * the step (the wizard requires one), and defaulting every purohit in the country
   * to Bengali is how a Chennai profile ends up claiming a language its owner does
   * not speak — nobody re-reads a prefilled answer.
   */
  useEffect(() => {
    setLanguages((cur) => (cur.size > 0 ? cur : new Set([languageOptions[0]!.code])));
  }, [languageOptions]);

  /** Each step persists as you leave it, so nothing is lost by closing the tab. */
  const advance = async () => {
    setBusy(true); setErr(null);
    try {
      if (at === 0) {
        await api('/v1/me/purohit/profile', {
          method: 'PUT',
          body: JSON.stringify({
            bio: bio.trim() || undefined,
            experienceYears: Number(years || 0),
            languages: [...languages],
            traditions: [...traditions],
            serviceRadiusKm: radius,
            citySlug,
            // The chosen city's coordinates, not the header's — otherwise a purohit
            // who browsed another city saves that city's location as their base.
            baseLat: getRegion(citySlug).coords.lat,
            baseLng: getRegion(citySlug).coords.lng,
            cashJobsEnabled: true,
            chantingSampleUrl: chantUrl.trim() || undefined,
            chantingSampleLabel: chantLabel.trim() || undefined,
          }),
        });
      }
      if (at === 2) {
        await api('/v1/me/purohit/services', {
          method: 'PUT',
          body: JSON.stringify({
            services: [...chosen].map((id) => ({ ritualId: id, pricePaise: prices[id] ?? 0 })),
          }),
        });
      }
      if (at === 4) {
        const r = await api<{ slotsOpen: number }>('/v1/me/purohit/availability', { method: 'POST' });
        setSlotsOpen(r.slotsOpen);
        setDone(true);
        return;
      }
      setAt((n) => n + 1);
      window.scrollTo({ top: 0 });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  /*
   * Step 3 is passable without an account on purpose.
   *
   * Requiring bank details before a purohit may open their calendar would block
   * signup on the one screen where someone is most likely to abandon — many will not
   * have an IFSC to hand on a phone, outdoors. So they may continue, and the
   * dashboard then carries an unmissable panel until it is done, with payouts
   * refused by the API in the meantime. Nothing is lost, and nothing is silently
   * broken either.
   */
  const canAdvance =
    at === 0 ? years !== '' && languages.size > 0 && traditions.size > 0
    : at === 1 ? chosen.size > 0
    : true;

  if (loading) {
    return <div className="wrap wiz"><div className="card"><div className="sk sk-line" /></div></div>;
  }

  if (done) {
    return (
      <div className="wrap wiz">
        <div className="card wiz-done">
          <div className="tick" aria-hidden="true">✓</div>
          <h1>You are set up</h1>
          <p className="muted">
            {slotsOpen} slots open over the next 120 days, {picked.length} services,
            in {getRegion(citySlug).name.en}.
          </p>
          {!payout?.linked && (
            <div className="notice warn">
              <strong>We still cannot pay you.</strong> Add a bank account or UPI id
              from your jobs page — your earnings wait on your balance until then.
            </div>
          )}
          {kyc !== 'verified' && (
            <div className="notice quiet">
              One step left, and it is ours: an admin reviews your account before
              devotees can book you. You will get a message when that is done.
            </div>
          )}
          <button className="btn-block" onClick={() => router.push('/purohit')}>
            Go to my jobs
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap wiz">
      {/* Progress before anything else: a purohit on a small screen needs to know
          how much is left before they decide to start. */}
      <div className="wiz-rail" role="group" aria-label={`Step ${at + 1} of ${STEPS.length}`}>
        {STEPS.map((s, i) => (
          <div key={s} className={`seg ${i < at ? 'done' : i === at ? 'on' : ''}`}>
            <span className="bar" />
            <span className="lb">{s}</span>
          </div>
        ))}
      </div>

      {err && <div className="notice err">{err}</div>}

      {at === 0 && (
        <section className="wiz-step">
          <h1>How long have you been practising?</h1>
          <p className="sub">This is the first thing a family looks at.</p>

          <div className="field big">
            <label htmlFor="years">Years</label>
            <input id="years" type="number" inputMode="numeric" min={0} max={80}
                   value={years} placeholder="20"
                   onChange={(e) => setYears(e.target.value.replace(/\D/g, ''))} />
          </div>

          <h2 className="wiz-q">Which city do you work in?</h2>
          <p className="sub" style={{ marginBottom: 14 }}>
            Devotees only see you in this city. Get it wrong and nobody can book you.
          </p>
          <div className="pickgrid">
            {regions.map((r) => (
              <button key={r.slug} type="button"
                      className={`pickbox${citySlug === r.slug ? ' on' : ''}`}
                      aria-pressed={citySlug === r.slug}
                      onClick={() => setCitySlug(r.slug)}>{r.name.en}</button>
            ))}
          </div>

          <h2 className="wiz-q">Which languages do you conduct in?</h2>
          <div className="pickgrid">
            {languageOptions.map((l) => (
              <button key={l.code} type="button"
                      className={`pickbox${languages.has(l.code) ? ' on' : ''}`}
                      aria-pressed={languages.has(l.code)}
                      onClick={() => flip(languages, l.code, setLanguages)}>
                {l.en}
                {l.native !== l.en && <span className="s">{l.native}</span>}
              </button>
            ))}
          </div>

          <h2 className="wiz-q">Which tradition do you follow?</h2>
          <div className="pickgrid">
            {TRADITIONS.map((t) => (
              <button key={t.id} type="button"
                      className={`pickbox${traditions.has(t.id) ? ' on' : ''}`}
                      aria-pressed={traditions.has(t.id)}
                      onClick={() => flip(traditions, t.id, setTraditions)}>
                {t.en}
                <span className="s">{t.note}</span>
              </button>
            ))}
          </div>

          <h2 className="wiz-q">How far will you travel?</h2>
          <div className="pickgrid">
            {RADII.map((r) => (
              <button key={r} type="button"
                      className={`pickbox${radius === r ? ' on' : ''}`}
                      aria-pressed={radius === r}
                      onClick={() => setRadius(r)}>{r} km</button>
            ))}
          </div>

          {/* The single strongest trust signal in this category, and the cheapest.
              A family can hear the pronunciation before they commit. */}
          <h2 className="wiz-q">A recording of your chanting</h2>
          <p className="sub" style={{ marginBottom: 14 }}>
            Devotees listen to this before booking. Record 30 seconds on your phone,
            upload it anywhere that gives a public link, and paste it here.
          </p>
          <div className="field">
            <label htmlFor="chant-url">Link to the recording (optional)</label>
            <input id="chant-url" type="url" value={chantUrl}
                   placeholder="https://…"
                   onChange={(e) => setChantUrl(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="chant-label">What are you reciting?</label>
            <input id="chant-label" value={chantLabel} maxLength={80}
                   placeholder="Ganapati Atharvashirsha"
                   onChange={(e) => setChantLabel(e.target.value)} />
          </div>

          <div className="field">
            <label htmlFor="bio">Anything else? (optional)</label>
            <input id="bio" value={bio} maxLength={200}
                   placeholder="Smarta vidhi, Kolkata and Howrah"
                   onChange={(e) => setBio(e.target.value)} />
          </div>
        </section>
      )}

      {at === 1 && (
        <section className="wiz-step">
          <h1>What do you perform?</h1>
          <p className="sub">
            Tap everything you do. You set the dakshina for each on the next screen.
          </p>

          <div className="spread" style={{ marginBottom: 14 }}>
            <span className="muted">{chosen.size} of {catalogue.length} selected</span>
            <button className="linkish"
                    onClick={() => setChosen(chosen.size === catalogue.length
                      ? new Set()
                      : new Set(catalogue.map((c) => c.id)))}>
              {chosen.size === catalogue.length ? 'Clear all' : 'Select all'}
            </button>
          </div>

          {/* Tap targets, not a spreadsheet of checkboxes. */}
          <div className="pickgrid two">
            {catalogue.map((c) => (
              <button key={c.id} type="button"
                      className={`pickbox wide${chosen.has(c.id) ? ' on' : ''}`}
                      aria-pressed={chosen.has(c.id)}
                      onClick={() => flip(chosen, c.id, setChosen)}>
                <span className="t">{title(c.slug)}</span>
                <span className="s">{money(c.bandMin)} – {money(c.bandMax)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {at === 2 && (
        <section className="wiz-step">
          <h1>What do you charge?</h1>
          <p className="sub">
            The range is what {region.name.en} households typically pay. You are not
            bound by it — this is your dakshina, and the devotee sees it.
          </p>

          <div className="ratelist">
            {picked.map((c) => (
              <div className="rate" key={c.id}>
                <div>
                  <div className="nm">{title(c.slug)}</div>
                  <div className="rg">typically {money(c.bandMin)} – {money(c.bandMax)}</div>
                </div>
                <div className="amt">
                  <span aria-hidden="true">₹</span>
                  <input type="number" inputMode="numeric"
                         aria-label={`Your dakshina for ${title(c.slug)}`}
                         value={Math.round((prices[c.id] ?? c.bandDefault) / 100)}
                         onChange={(e) => setPrices({
                           ...prices, [c.id]: Math.round(Number(e.target.value) * 100),
                         })} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {at === 3 && (
        <section className="wiz-step">
          <h1>Where should we send your money?</h1>
          <p className="sub">
            You can do this later, but we cannot pay you until it is done — what you
            earn simply waits on your balance.
          </p>

          <PayoutAccountForm account={payout} onSaved={setPayout} compact />
        </section>
      )}

      {at === 4 && (
        <section className="wiz-step">
          <h1>When are you free?</h1>
          <p className="sub">
            We will open every slot for the next 120 days. You can close individual
            days afterwards.
          </p>

          <div className="notice quiet">
            <strong>An open slot is a commitment.</strong> A devotee who books one is
            confirmed straight away — you are not asked to accept first. If you cannot
            take a job, release it early and we will find them someone else.
          </div>
        </section>
      )}

      <div className="wiz-foot">
        {at > 0 && (
          <button className="btn outline" disabled={busy}
                  onClick={() => { setAt((n) => n - 1); window.scrollTo({ top: 0 }); }}>
            Back
          </button>
        )}
        <button className="btn-block" disabled={busy || !canAdvance} onClick={advance}>
          {busy ? 'Saving…'
            : at === 4 ? 'Open my calendar'
            : at === 3 ? (payout?.linked ? 'Continue' : 'I will add this later')
            : at === 1 ? `Continue with ${chosen.size}`
            : 'Continue'}
        </button>
      </div>
    </div>
  );
}
