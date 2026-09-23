// lib/geocode.js — Sep 23 2026, Geolocation Delivery System Phase 1.
//
// Single shared place any route can call to turn a typed address into
// real coordinates, the same "server-side call, real key in an env
// var, never touches the client" pattern already used for the AI
// insights proxy (routes-postgres/ai.js). Deliberately its own module
// rather than inlined in destinations.js — customers.js and orders.js
// will need the exact same call in Phase 1b (geocoding customer/order
// delivery addresses), and this is the one place that logic should
// live so all three stay consistent.
//
// GOOGLE_MAPS_SERVER_KEY is a SEPARATE key from the one that will
// eventually load the Maps JavaScript API in the browser (that one is
// meant to be public, restricted by HTTP referrer). This key is never
// sent to the client — it's used for paid, metered calls (Geocoding,
// later Directions) that must never be embeddable in a public static
// HTML file, or anyone viewing page source could run up the bill.
//
// Fails soft everywhere: no key configured yet, network error, no
// match found, or a malformed response all return null rather than
// throwing — callers treat "couldn't geocode this one" as a normal,
// expected outcome (same as "no valid phone for this order" elsewhere
// in this codebase), never a reason to fail the surrounding request.
async function geocodeAddress(address) {
  const apiKey = process.env.GOOGLE_MAPS_SERVER_KEY;
  if(!apiKey) {
    console.warn('[geocode] GOOGLE_MAPS_SERVER_KEY is not set — skipping geocode for:', address);
    return null;
  }
  if(!address || typeof address !== 'string' || !address.trim()) return null;

  try {
    // region=ng biases ambiguous matches toward Nigeria without
    // excluding results outside it; Google's geocoder also natively
    // resolves Plus Codes (e.g. "Q2QQ+H47, Port Harcourt") typed
    // straight into the address field, no special-casing needed here.
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address.trim())}&region=ng&key=${apiKey}`;
    const resp = await fetch(url);
    if(!resp.ok) {
      console.error(`[geocode] Google Geocoding API HTTP error ${resp.status} for:`, address);
      return null;
    }
    const data = await resp.json();
    if(data.status !== 'OK' || !data.results?.length) {
      // ZERO_RESULTS is routine (a bad/incomplete address) — only log
      // the genuinely abnormal statuses (key problems, quota, etc.)
      if(data.status !== 'ZERO_RESULTS') {
        console.error(`[geocode] Google Geocoding API status "${data.status}" for:`, address, data.error_message || '');
      }
      return null;
    }
    const top = data.results[0];
    return {
      latitude: top.geometry.location.lat,
      longitude: top.geometry.location.lng,
      formattedAddress: top.formatted_address,
    };
  } catch(networkErr) {
    console.error('[geocode] Network error calling Google Geocoding API for:', address, networkErr.message);
    return null;
  }
}

module.exports = { geocodeAddress };
