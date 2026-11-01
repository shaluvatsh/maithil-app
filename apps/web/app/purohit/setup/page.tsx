'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, auth } from '@/lib/api';
import { useRegion } from '@/lib/region-context';
import { getRegion, languagesFor, TRADITIONS } from '@themaithil/region';
import { PayoutAccountForm, type PayoutAccount } from '@/components/purohit/payout-account';

/**
 * Purohit setup — a WIZARD before approval, EDITABLE PANELS after it.
 *
 * Two shapes for two jobs, because they are genuinely different jobs. A wizard is for
 * "I do not yet know what is being asked of me": one decision per screen, progress at
 * the top, no way to get lost. Editing is the opposite — "I know exactly what I want
 * to change, take me there" — and making a verified purohit re-enter a four-step flow
 * to change one rate is how they stop maintaining their calendar, which ADR 0012
 * identifies as the start of the supply death spiral.
 *
 * So once `kyc_status` is `verified` the rail and the Continue button disappear, every
 * step becomes a panel with a stable id (`#practice`, `#services`, `#rates`,
 * `#payout`, `#calendar`) and its own save, and the dashboard's "Fix this" links point
 * at the panel for the problem they describe rather than at step one.
 *
 * The step CONTENT is shared deliberately. Two copies of "which languages do you
 * conduct in" would drift, and the drift would be invisible: one of them is only ever
 * seen by new purohits and the other only by established ones.
 *
 * Original note on the wizard, which still holds for the unapproved case:
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
  /**
   * Which panel last saved, and what each panel looked like when it did.
   *
   * THE BUG THIS REPLACES, which I shipped: `saved` was set and never cleared, so
   * "Saved" sat on the panel for ever. Edit the same field again and it still said
   * Saved — a confirmation that had become a lie, next to a Save button that was
   * always enabled and so told you nothing about whether there was anything to save.
   *
   * `clean` holds each panel's persisted shape. Comparing the live form against it
   * gives three honest states instead of one dishonest one: nothing to save, unsaved
   * changes, and saved.
   */
  const [saved, setSaved] = useState<string | null>(null);
  const [clean, setClean] = useState<Record<string, string>>({});

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

  /**
   * Approved purohits edit; everybody else is onboarding.
   *
   * Keyed on verification rather than on "have they finished the wizard", because
   * verification is the point at which the wizard has nothing left to tell them —
   * before it, the sequence IS the information.
   */
  const editing = kyc === 'verified';

  /**
   * Collapsed by default once a purohit is editing rather than onboarding.
   *
   * THE SECOND COMPLAINT THIS ANSWERS: "once saved it should not show the same
   * form." Before this, the practice fields stayed open and editable for ever —
   * saving just disabled the Save button next to a page of inputs that never went
   * away. `PayoutAccountPanel` already solved this exact problem for the payout
   * form (see its own comment: "Settled: a quiet line… expandable to change it")
   * and this follows the same shape rather than inventing a second one.
   */
  const [practiceOpen, setPracticeOpen] = useState(false);

  /*
   * A stray `#practice` still opens the form directly, for anything that links here
   * with the old fragment. Every current link now points at the bare page — there
   * is only one section left to open — but this costs nothing to keep and means a
   * bookmarked or cached URL does not quietly regress to "load, then hunt for Edit."
   */
  useEffect(() => {
    if (!editing || window.location.hash.replace('#', '') !== 'practice') return;
    setPracticeOpen(true);
  }, [editing]);

  /**
   * Save one panel, in edit mode.
   *
   * The same three writes `advance` performs, addressed individually — a purohit
   * changing their rate must not have their calendar reopened as a side effect.
   */
  /**
   * Close the form WITHOUT keeping whatever was typed.
   *
   * `setPracticeOpen(false)` alone would hide the inputs but leave their React state
   * exactly as edited — so the collapsed summary line, which reads straight from
   * that state, would show the unsaved change as though it had been saved. This
   * restores every field from `clean.practice`, the last snapshot taken at load or
   * at a real save, before collapsing.
   */
  const cancelPractice = () => {
    const snapshot = clean.practice;
    if (snapshot) {
      const p = JSON.parse(snapshot) as {
        years: string; bio: string; radius: number; citySlug: string;
        chantUrl: string; chantLabel: string; languages: string[]; traditions: string[];
      };
      setYears(p.years); setBio(p.bio); setRadius(p.radius); setCitySlug(p.citySlug);
      setChantUrl(p.chantUrl); setChantLabel(p.chantLabel);
      setLanguages(new Set(p.languages)); setTraditions(new Set(p.traditions));
    }
    setPracticeOpen(false);
  };

  /**
   * Saves the one panel edit mode actually has.
   *
   * Used to take a `panel` argument and branch on 'rates' / 'calendar' too, back
   * when this page saved all five wizard steps as edit-mode panels. Those moved to
   * `/purohit/rates` and `/purohit/payouts`; `show()` now renders step 0 only when
   * editing, so those branches had no caller left to reach them.
   */
  const savePanel = async () => {
    setBusy(true); setErr(null); setSaved(null);
    try {
      await saveProfile();
      setPracticeOpen(false);
      setSaved('practice');
      // Re-baseline, so the panel immediately reads as "nothing to save" and an
      // edit afterwards clears the confirmation rather than sitting beside it.
      markClean();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  /** What the practice panel currently holds, serialised for comparison. */
  const panelNow: Record<string, string> = {
    practice: JSON.stringify({
      years, bio, radius, citySlug, chantUrl, chantLabel,
      languages: [...languages].sort(), traditions: [...traditions].sort(),
    }),
  };

  /** Unsaved changes in this panel. False until the first load has settled. */
  const isDirty = (panel: string) =>
    clean[panel] !== undefined && clean[panel] !== panelNow[panel];

  const anyDirty = Object.keys(panelNow).some(isDirty);

  /** Snapshot every panel as persisted — after load, and after each save. */
  const markClean = () => setClean({ ...panelNow });

  /*
   * Once the form has loaded, whatever is on screen IS what is stored.
   *
   * Without this the first comparison is against `undefined` and every panel reads as
   * dirty before the purohit has touched anything.
   */
  useEffect(() => {
    if (loading || !editing) return;
    setClean((cur) => (Object.keys(cur).length ? cur : { ...panelNow }));
    // Deliberately keyed on load alone: re-running on every keystroke would
    // re-baseline the snapshot and nothing would ever read as dirty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, editing]);

  /**
   * The wizard's promise was "nothing is lost by closing the tab", because it saved on
   * advance. Edit mode has no advance, so it has to warn instead — otherwise a purohit
   * who edits their rate and closes the tab loses it with nothing said.
   */
  useEffect(() => {
    if (!editing || !anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editing, anyDirty]);

  /** Each step persists as you leave it, so nothing is lost by closing the tab. */
  const saveProfile = () =>
        api('/v1/me/purohit/profile', {
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

  const saveServices = () =>
        api('/v1/me/purohit/services', {
          method: 'PUT',
          body: JSON.stringify({
            services: [...chosen].map((id) => ({ ritualId: id, pricePaise: prices[id] ?? 0 })),
          }),
        });

  /** Each step persists as you leave it, so nothing is lost by closing the tab. */
  const advance = async () => {
    setBusy(true); setErr(null);
    try {
      if (at === 0) await saveProfile();
      if (at === 2) await saveServices();
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
  /**
   * Whether this rate falls outside the range devotees are shown for it.
   *
   * The API refuses these (RATE_OUT_OF_BAND), and it has to — since ADR 0012 the
   * platform assigns the purohit, so a devotee cannot avoid an out-of-band rate by
   * choosing someone else; they meet it at the payment screen. But a rejection that
   * arrives on submit names one service out of forty on a page the purohit has
   * scrolled past. Saying it beside the input, as they type, is the same rule
   * arriving while they can still act on it.
   */
  const outOfBand = (c: CatalogueRow) => {
    const p = prices[c.id] ?? c.bandDefault;
    return p < c.bandMin || p > c.bandMax;
  };

  const canAdvance =
    at === 0 ? years !== '' && languages.size > 0 && traditions.size > 0
    : at === 1 ? chosen.size > 0
    : at === 2 ? !picked.some(outOfBand)
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
          {/*
            "An admin reviews your account" was shown for every non-verified state,
            including `pending` — which means the purohit has not uploaded anything
            yet. So someone who had sent us no ID was told we were checking it, and
            waited. The admin queue meanwhile showed them with zero documents and
            could do nothing either: a deadlock made entirely of copy.
          */}
          {kyc === 'submitted' && (
            <div className="notice quiet">
              One step left, and it is ours: we are checking your documents before
              devotees can book you. You will get a message when that is done.
            </div>
          )}
          {(kyc === 'pending' || kyc === 'rejected') && (
            <div className="notice warn">
              <strong>
                {kyc === 'rejected'
                  ? 'We could not verify your documents.'
                  : 'One step left, and it is yours.'}
              </strong>{' '}
              {kyc === 'rejected'
                ? 'Send them again from your jobs page and we will take another look.'
                : 'Send us your ID from your jobs page — devotees cannot see you until '
                  + 'we have checked it, and we cannot start until you send it.'}
            </div>
          )}
          <button className="btn-block" onClick={() => router.push('/purohit')}>
            Go to my jobs
          </button>
        </div>
      </div>
    );
  }

  /*
   * Edit mode shows ONLY step 0 (practice/identity). Steps 1-4 — services & rates,
   * payout, calendar — moved to their own routes (`/purohit/rates`,
   * `/purohit/payouts`), reachable from the profile menu. Stacking all five on one
   * page was the "too long" complaint: a purohit editing their languages had to
   * scroll past a 32-item service picker, a payout form and a calendar action to get
   * there. The wizard still shows exactly one step at a time, unchanged.
   */
  const show = (n: number) => (editing ? n === 0 : at === n);

  return (
    <div className={editing ? 'wrap wiz editing' : 'wrap wiz'}>
      {editing ? (
        <header className="panel-head">
          <h1>My practice</h1>
          <p className="sub">
            How devotees find and judge you — years, city, languages and your
            chanting sample. Change it any time.
          </p>
          {/* Visible without hunting for the section it belongs to: a purohit who has
              edited two panels and saved one needs to know at a glance. */}
          {anyDirty && (
            <p className="panel-unsaved">You have changes that are not saved yet.</p>
          )}
        </header>
      ) : (
        /* Progress before anything else: a purohit on a small screen needs to know
           how much is left before they decide to start. */
        <div className="wiz-rail" role="group" aria-label={`Step ${at + 1} of ${STEPS.length}`}>
          {STEPS.map((label, i) => (
            <div key={label} className={`seg ${i < at ? 'done' : i === at ? 'on' : ''}`}>
              <span className="bar" />
              <span className="lb">{label}</span>
            </div>
          ))}
        </div>
      )}

      {err && <div className="notice err">{err}</div>}

      {show(0) && (
        <section className="wiz-step" id="practice">
          {editing && <h2 className="panel-h">Your practice</h2>}

          {/*
            * Collapsed: a one-line summary built from what is already saved, plus
            * Edit. This is the state a verified purohit sees on every return visit —
            * short, scannable, and not a form sitting open with nothing to do.
            */}
          {editing && !practiceOpen && (
            <div className="practice-summary">
              <p className="practice-sum-line">
                {years || '0'} years · {getRegion(citySlug).name.en}
                {' · '}
                {[...languages].map((code) =>
                  languageOptions.find((l) => l.code === code)?.en ?? code).join(', ')}
                {traditions.size > 0 && (
                  <> · {[...traditions].map((id) =>
                    TRADITIONS.find((t) => t.id === id)?.en ?? id).join(', ')}</>
                )}
                {' · '}{radius} km
                {chantUrl.trim() && ' · chanting sample added'}
              </p>
              <button className="btn outline sm" onClick={() => setPracticeOpen(true)}>
                Edit
              </button>
            </div>
          )}

          {(!editing || practiceOpen) && (
          <>
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
                      className={`opt${citySlug === r.slug ? ' on' : ''}`}
                      aria-pressed={citySlug === r.slug}
                      onClick={() => setCitySlug(r.slug)}>{r.name.en}</button>
            ))}
          </div>

          <h2 className="wiz-q">Which languages do you conduct in?</h2>
          <div className="pickgrid">
            {languageOptions.map((l) => (
              <button key={l.code} type="button"
                      className={`opt${languages.has(l.code) ? ' on' : ''}`}
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
                      className={`opt${traditions.has(t.id) ? ' on' : ''}`}
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
                      className={`opt${radius === r ? ' on' : ''}`}
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

          {editing && (
            <div className="panel-save">
              {/*
                * Three states, and the button carries all of them: disabled when
                * there is nothing to save, live when there is, and "Saving…" while
                * it goes. An always-enabled button tells a purohit nothing about
                * whether their change has landed.
                */}
              <button
                className="btn" disabled={busy || !isDirty('practice')}
                onClick={() => void savePanel()}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
              {/* A way out that does not save. Dirty state otherwise follows them
                  back to the collapsed view, which would make "Edit" look like it
                  silently kept a change they meant to discard. */}
              <button
                className="btn ghost sm" disabled={busy}
                onClick={cancelPractice}
              >
                Cancel
              </button>
              {isDirty('practice')
                ? <span className="panel-dirty">Not saved yet</span>
                : saved === 'practice' && <span className="panel-saved">Saved ✓</span>}
            </div>
          )}
          </>
          )}
        </section>
      )}

      {show(1) && (
        <section className="wiz-step" id="services">
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
                      className={`opt${chosen.has(c.id) ? ' on' : ''}`}
                      aria-pressed={chosen.has(c.id)}
                      onClick={() => flip(chosen, c.id, setChosen)}>
                <span className="t">{title(c.slug)}</span>
                <span className="s">{money(c.bandMin)} – {money(c.bandMax)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {show(2) && (
        <section className="wiz-step" id="rates">
          <h1>What do you charge?</h1>
          <p className="sub">
            This is your dakshina, and the devotee sees it. Keep it inside the range
            shown for each service — that is the price {region.name.en} households
            were quoted when they chose it, and we do not let them be charged more
            than we advertised. If a range is wrong for your work, tell us and we
            will look at it.
          </p>

          <div className="ratelist">
            {picked.map((c) => {
              const bad = outOfBand(c);
              return (
                <div className={`rate${bad ? ' bad' : ''}`} key={c.id}>
                  <div>
                    <div className="nm">{title(c.slug)}</div>
                    <div className="rg">{money(c.bandMin)} – {money(c.bandMax)}</div>
                  </div>
                  <div className="amt">
                    <span aria-hidden="true">₹</span>
                    <input type="number" inputMode="numeric"
                           aria-label={`Your dakshina for ${title(c.slug)}`}
                           aria-invalid={bad || undefined}
                           aria-describedby={bad ? `rate-err-${c.id}` : undefined}
                           value={Math.round((prices[c.id] ?? c.bandDefault) / 100)}
                           onChange={(e) => setPrices({
                             ...prices, [c.id]: Math.round(Number(e.target.value) * 100),
                           })} />
                  </div>
                  {bad && (
                    <p className="rate-err" id={`rate-err-${c.id}`} role="alert">
                      Choose an amount between {money(c.bandMin)} and {money(c.bandMax)}.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

        </section>
      )}

      {show(3) && (
        <section className="wiz-step" id="payout">
          <h1>Where should we send your money?</h1>
          <p className="sub">
            You can do this later, but we cannot pay you until it is done — what you
            earn simply waits on your balance.
          </p>

          <PayoutAccountForm account={payout} onSaved={setPayout} compact />
          {/* No Save beside this one: the form posts on its own, and a second button
              that did nothing would be the most confusing control on the page. */}
        </section>
      )}

      {show(4) && (
        <section className="wiz-step" id="calendar">
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

      {/* The wizard's footer, and only the wizard's: in edit mode there is nothing to
          advance to, and a Continue button on a settings page is a question with no
          answer. */}
      {!editing && (
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
      )}

      {editing && (
        <p className="panel-foot muted">
          Services &amp; rates, payouts and your dashboard moved — find them under your
          name, top right.
        </p>
      )}
    </div>
  );
}
