import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { pincodeCentroids } from '../../db/schema/index';
import { getRegion } from '@themaithil/region';

export type GeoPrecision = 'exact' | 'pincode' | 'city';

export interface ResolvedPoint {
  lat: number;
  lng: number;
  precision: GeoPrecision;
}

/**
 * Turns an address into a coordinate, and says how much that coordinate is worth.
 *
 * Three tiers, most precise first:
 *
 *   `exact`   — the devotee's own device or a dropped pin. The only tier good
 *               enough to route a person to a door.
 *   `pincode` — the centroid of their pincode, from `pincode_centroids`. A couple
 *               of km across inside a city; enough to tell Gariahat from Salt Lake,
 *               and therefore enough for a travel estimate to carry information.
 *   `city`    — the city centroid, which `packages/region` has always had. The
 *               floor, and the reason this service exists: EVERY address created
 *               through the product currently lands here, so any two of them are
 *               the same point and the travel time between them is exactly zero.
 *
 * Nothing is ever invented. If the pincode is not in the table, resolution falls
 * to the city and reports `city` — a coarse answer that admits it is coarse, which
 * downstream can widen a margin against. A fabricated coordinate would be worse
 * than a coarse one: it looks precise and sends a purohit to the wrong place.
 */
export class GeocodeService {
  constructor(private readonly db: Db) {}

  async resolve(args: {
    citySlug: string;
    pincode: string;
    /** Supplied by the client when the devotee shares their location. */
    lat?: number | undefined;
    lng?: number | undefined;
  }): Promise<ResolvedPoint> {
    if (args.lat !== undefined && args.lng !== undefined) {
      return { lat: args.lat, lng: args.lng, precision: 'exact' };
    }

    const [row] = await this.db.select({
      lat: pincodeCentroids.lat, lng: pincodeCentroids.lng,
    }).from(pincodeCentroids).where(eq(pincodeCentroids.pincode, args.pincode)).limit(1);

    if (row) return { lat: row.lat, lng: row.lng, precision: 'pincode' };

    const centroid = getRegion(args.citySlug).coords;
    return { lat: centroid.lat, lng: centroid.lng, precision: 'city' };
  }
}
