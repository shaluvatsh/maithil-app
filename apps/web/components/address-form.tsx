'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useRegion } from '@/lib/region-context';

export interface SavedAddress {
  id: string;
  label: string | null;
  line1: string;
  line2: string | null;
  pincode: string;
  /**
   * Resolved by the API from the `citySlug` this form posts, and returned so the
   * caller can drop the row straight into a list without inventing a city for it —
   * `/book` used to label every address with the header's current city instead.
   */
  city: string;
  citySlug: string;
}

/**
 * Adding a venue, in one place.
 *
 * ONE OWNER, for the reason `components/field.tsx` sets out at length: this markup
 * plus its geolocation handshake plus the `citySlug: region.slug` it has to post was
 * written inline inside `/book`'s 1,200-line page, and the account page needed the
 * same thing. A second copy would have been the third place in this repo where one
 * form was written out per screen.
 *
 * Two details here are not cosmetic and are exactly what a re-implementation would
 * have got wrong:
 *
 * - **`citySlug` comes from the region, not from a text input.** The API resolves it
 *   against `cities.slug` and 404s on anything else, so a free-text city field is a
 *   guaranteed error for every city whose display name is not its slug.
 * - **The shared coordinate is optional and is never requested unasked.** Without it
 *   an address resolves to its pincode centroid, or to the city's — and the travel
 *   time between two city-centroid addresses is exactly zero (GeocodeService,
 *   ADR 0013). So it is worth asking for, and worth explaining before asking.
 */
export function AddressForm({
  onSaved, onCancel, idPrefix = 'addr',
}: {
  /** Handed the row the API returned, so the caller can select it immediately. */
  onSaved: (saved: SavedAddress) => void;
  /** Omitted when there is nothing to go back to — a first address has no cancel. */
  onCancel?: (() => void) | undefined;
  /**
   * Both callers can be mounted on the same page in principle, and duplicate `id`
   * attributes silently break `htmlFor` — the label stops pointing at the input.
   */
  idPrefix?: string;
}) {
  const { region } = useRegion();
  const [form, setForm] = useState({ label: 'Home', line1: '', line2: '', pincode: '' });
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateErr, setLocateErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /**
   * Asks the browser, which asks the person. Never automatic: a location prompt
   * that fires unasked reads as surveillance, and this one is worth explaining
   * first — it is why the purohit arrives on time.
   */
  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setLocateErr('This browser cannot share a location. The pincode will be used instead.');
      return;
    }
    setLocating(true); setLocateErr(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      () => {
        // Declining is a legitimate choice, not an error state to nag about.
        setLocateErr('No location shared — we will use your pincode instead.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  };

  /*
   * The same two rules the API enforces, checked here so the reader is told which
   * field is wrong instead of reading a 422 about the request body. `line1` min 4
   * and a six-digit pincode not starting with 0 are `AddressInput` in
   * booking-read.controller.ts; keeping them in step matters more than keeping them
   * DRY, because the server's copy is the one that is load-bearing.
   */
  const pinOk = /^[1-9][0-9]{5}$/.test(form.pincode.trim());
  const lineOk = form.line1.trim().length >= 4;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const saved = await api<SavedAddress>('/v1/me/addresses', {
        method: 'POST',
        body: JSON.stringify({
          label: form.label.trim() || 'Home',
          line1: form.line1.trim(),
          line2: form.line2.trim() || undefined,
          citySlug: region.slug,
          pincode: form.pincode.trim(),
          ...(coords ?? {}),
        }),
      });
      onSaved(saved);
      setForm({ label: 'Home', line1: '', line2: '', pincode: '' });
      setCoords(null); setLocateErr(null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="addr-form">
      {err && <div className="notice err">{err}</div>}
      <div className="field">
        <label htmlFor={`${idPrefix}-label`}>Label</label>
        <input id={`${idPrefix}-label`} value={form.label}
               placeholder="Home, Office, Ma's place"
               onChange={(e) => setForm((n) => ({ ...n, label: e.target.value }))} />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-line1`}>Flat, building, street</label>
        <input id={`${idPrefix}-line1`} value={form.line1}
               placeholder="12 Hindusthan Park"
               onChange={(e) => setForm((n) => ({ ...n, line1: e.target.value }))} />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-line2`}>Area or landmark</label>
        <input id={`${idPrefix}-line2`} value={form.line2}
               placeholder="Gariahat"
               onChange={(e) => setForm((n) => ({ ...n, line2: e.target.value }))} />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-pin`}>Pincode</label>
        <input id={`${idPrefix}-pin`} value={form.pincode} inputMode="numeric"
               maxLength={6} placeholder="700029"
               aria-describedby={`${idPrefix}-pin-hint`}
               onChange={(e) => setForm((n) => ({ ...n, pincode: e.target.value }))} />
        {form.pincode.trim().length > 0 && !pinOk && (
          <span id={`${idPrefix}-pin-hint`} className="field-hint muted">
            Six digits, as on your post — the purohit&apos;s travel is worked out from it.
          </span>
        )}
      </div>
      {/*
        Optional, and explained rather than demanded. A precise point is what lets
        us judge whether a purohit can actually reach you between two jobs; without
        it we fall back to the pincode, which is a couple of kilometres wide.
      */}
      <div className="geo-ask">
        {coords ? (
          <span className="geo-ok">Exact location saved for this address.</span>
        ) : (
          <>
            <button type="button" className="btn outline sm"
                    onClick={useMyLocation} disabled={locating}>
              {locating ? 'Locating…' : 'Use my current location'}
            </button>
            <span className="faint">
              Optional. Helps your purohit arrive on time — we only ask
              when you are at the address.
            </span>
          </>
        )}
      </div>
      {locateErr && (
        <p className="faint" style={{ fontSize: '.82rem', margin: '0 0 8px' }}>
          {locateErr}
        </p>
      )}
      <p className="faint" style={{ fontSize: '.82rem', margin: '0 0 12px' }}>
        Saving to {region.name.en}. Change your city in the header if that is wrong.
      </p>
      <div className="row">
        {/*
          Disabled until the server would accept it. This used to be enabled from
          the moment the form opened, so the quickest way to discover that `line1`
          has a minimum length was to submit an empty form and read a validation
          error written for an API client.
        */}
        <button className="btn" disabled={busy || !lineOk || !pinOk} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save address'}
        </button>
        {onCancel && (
          <button className="btn outline" onClick={onCancel}>Cancel</button>
        )}
      </div>
    </div>
  );
}
