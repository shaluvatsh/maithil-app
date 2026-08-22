'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useRegion } from '@/lib/region-context';
import { computableSchool } from '@themaithil/region';

/**
 * Resolving which almanac to actually show.
 *
 * The region config names a default — Kolkata's is Gupta Press — and both the home
 * page and `/panchang` requested it directly. Under ADR 0003 Gupta Press is
 * transcribed by hand and has never been transcribed, so the API returned `[]`,
 * the home strip rendered nothing at all, and `/panchang` showed "not published
 * yet". The panchang was invisible in the launch city and the failure was silent,
 * because an empty array looks exactly like a quiet month.
 *
 * The client cannot know which school holds data, so it asks. Preference is
 * honoured when it is published and falls back to whatever is, with `substituted`
 * set so the UI can say so rather than quietly showing a different tradition —
 * which almanac a family follows is not a detail to swap without telling them.
 */
export interface PanchangSchool {
  id: string;
  english: string;
  native: string;
  note: string;
  computable: boolean;
  published: boolean;
  from: string | null;
  to: string | null;
}

export interface ResolvedSchool {
  /** Null until the lookup resolves; callers must not fetch days before then. */
  school: string | null;
  schools: PanchangSchool[];
  /** The preferred school exists but has no data, and we are showing another. */
  substituted: PanchangSchool | null;
  loading: boolean;
  /** Nothing at all is published for this city. */
  none: boolean;
  choose: (id: string) => void;
}

export function usePanchangSchool(): ResolvedSchool {
  const { region } = useRegion();
  const [schools, setSchools] = useState<PanchangSchool[]>([]);
  /** Which city `schools` describes. Without it, stale answers look current. */
  const [forCity, setForCity] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    const slug = region.slug;
    setLoading(true);
    setChosen(null);
    api<PanchangSchool[]>(`/v1/panchang/schools?citySlug=${slug}`, { auth: false })
      .then((list) => { if (live) { setSchools(list); setForCity(slug); } })
      // A failed lookup must not leave the page with no almanac at all: the city's
      // own computed school is always the safe assumption.
      .catch(() => { if (live) { setSchools([]); setForCity(slug); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [region.slug]);

  /**
   * Only ever describes the city currently selected.
   *
   * `schools` holds the previous city's answer until the new lookup resolves, and
   * reading it in between is how Ahmedabad kept showing Kolkata's almanac until you
   * refreshed the page. `forCity` is the guard: stale data is treated as no data.
   */
  const fresh = forCity === region.slug ? schools : [];
  const published = fresh.filter((s) => s.published);
  const preferred = fresh.find((s) => s.id === region.defaultPanjika) ?? null;

  const auto = preferred?.published
    ? preferred.id
    : published[0]?.id
      /**
       * Before the lookup lands, fall back to the drik almanac THIS city keeps.
       *
       * It used to fall back to the literal `'bisuddha_siddhanta'`, which is
       * Kolkata's name for its drik school and no other city's — so every other
       * city opened by requesting an almanac it does not offer.
       */
      ?? (loading || fresh.length === 0 ? computableSchool(region) : null);

  const school = chosen ?? auto;

  return {
    school,
    schools: fresh,
    substituted: preferred && !preferred.published && school !== preferred.id && !chosen
      ? preferred
      : null,
    // Still resolving whenever the answer we hold is for a different city.
    loading: loading || forCity !== region.slug,
    none: forCity === region.slug && !loading && fresh.length > 0 && published.length === 0,
    choose: setChosen,
  };
}
