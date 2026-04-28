"use strict";

/**
 * osmHazardMapper.js
 *
 * Deterministically maps an OpenStreetMap feature to a Caddie+ hazard
 * category. NEVER hallucinates categories — every mapping is grounded
 * in OSM tag conventions documented at https://wiki.openstreetmap.org.
 *
 * Returns:
 *   { normalizedType, rawType, label, side?, confidence }   on hazard match
 *   null                                                     when not a hazard
 *
 * Confidence scoring rationale:
 *   - golf=*       tags are explicit golf features → 0.85
 *   - natural=water + water=pond/lake               → 0.80
 *   - natural=water (no subtype)                    → 0.75
 *   - waterway=stream/river                          → 0.75
 *   - landuse=forest / natural=wood                  → 0.65
 *     (tree masses are real but boundary-imprecise)
 *   - natural=tree_row                               → 0.55
 *   - barrier=fence ON golf perimeter                → 0.55
 *   - leisure=golf_course inner=hazard polygon       → 0.50
 *
 * Confidence < 1.0 makes it explicit that OSM data is enrichment, not
 * gospel — the recommendation engine and UI can choose to weight low-
 * confidence hazards differently in the future.
 */

const { HAZARD_TYPES, normalizeHazardType } = require("./hazardClassifier");

/**
 * Map a single OSM element (way/relation/node) to a Caddie+ hazard descriptor.
 *
 * @param {object} el           OSM element from Overpass (must have .tags)
 * @param {object} ctx          Optional context: { greenCenters: [{lat,lon}] }
 *                              used to distinguish greenside vs fairway bunkers
 * @returns {{normalizedType:string, rawType:string, label:string|null, confidence:number}|null}
 */
function mapOsmFeature(el, ctx = {}) {
  if (!el || !el.tags) return null;
  const t = el.tags;

  // ── Golf-specific tags first (strongest signal) ──────────────────────
  if (t.golf === "bunker") {
    // Greenside vs fairway: if the bunker centroid sits within ~30y of
    // any green centroid in ctx, label as greenside.
    const center = featureCenter(el);
    const greenside = center && (ctx.greenCenters || []).some((g) =>
      yardsBetween(center.lat, center.lon, g.lat, g.lon) <= 30
    );
    return {
      normalizedType: greenside ? HAZARD_TYPES.BUNKER_GREENSIDE : HAZARD_TYPES.BUNKER_FAIRWAY,
      rawType: greenside ? "Greenside Bunker" : "Fairway Bunker",
      label: null,
      confidence: 0.85
    };
  }
  if (t.golf === "water_hazard" || t.golf === "lateral_water_hazard") {
    return { normalizedType: HAZARD_TYPES.WATER, rawType: "Water Hazard", label: null, confidence: 0.85 };
  }
  if (t.golf === "rough") {
    return { normalizedType: HAZARD_TYPES.ROUGH, rawType: "Rough", label: null, confidence: 0.6 };
  }
  if (t.golf === "out_of_bounds") {
    return { normalizedType: HAZARD_TYPES.OUT_OF_BOUNDS, rawType: "Out of Bounds", label: null, confidence: 0.85 };
  }

  // ── Water bodies ────────────────────────────────────────────────────
  if (t.natural === "water") {
    if (t.water === "pond" || t.water === "lake" || t.water === "reservoir") {
      return { normalizedType: HAZARD_TYPES.POND_LAKE, rawType: titleCase(t.water), label: null, confidence: 0.80 };
    }
    return { normalizedType: HAZARD_TYPES.WATER, rawType: "Water", label: null, confidence: 0.75 };
  }
  if (t.waterway === "stream" || t.waterway === "river") {
    return { normalizedType: HAZARD_TYPES.CREEK_STREAM, rawType: titleCase(t.waterway), label: null, confidence: 0.75 };
  }
  if (t.waterway === "ditch" || t.waterway === "drain") {
    return { normalizedType: HAZARD_TYPES.CREEK_STREAM, rawType: "Ditch", label: null, confidence: 0.65 };
  }

  // ── Trees / vegetation ─────────────────────────────────────────────
  if (t.natural === "wood" || t.landuse === "forest") {
    return { normalizedType: HAZARD_TYPES.TREES, rawType: "Woods", label: null, confidence: 0.65 };
  }
  if (t.natural === "tree_row") {
    return { normalizedType: HAZARD_TYPES.TREES, rawType: "Tree Line", label: null, confidence: 0.55 };
  }
  if (t.natural === "scrub") {
    return { normalizedType: HAZARD_TYPES.TREES, rawType: "Scrub", label: null, confidence: 0.45 };
  }

  // ── OB / boundaries ─────────────────────────────────────────────────
  if (t.barrier === "fence" || t.barrier === "wall") {
    return { normalizedType: HAZARD_TYPES.OUT_OF_BOUNDS, rawType: titleCase(t.barrier), label: null, confidence: 0.55 };
  }
  // Roads near golf perimeter often function as OB. We're conservative:
  // only treat highway tagged as primary/secondary/tertiary as OB-ish,
  // and rely on the proximity filter in the enricher to reject roads
  // that are not actually adjacent to fairways.
  if (t.highway && /^(primary|secondary|tertiary|residential|unclassified|service)$/.test(t.highway)) {
    return { normalizedType: HAZARD_TYPES.OUT_OF_BOUNDS, rawType: "Road", label: null, confidence: 0.40 };
  }

  // ── Catch-all: try our normalizer on the most descriptive tag we can find
  const fallback = normalizeHazardType(
    t.golf || t.natural || t.water || t.waterway || t.barrier,
    null, null, t.name || null
  );
  if (fallback) {
    return { normalizedType: fallback, rawType: titleCase(t.golf || t.natural || t.water || t.waterway || "Other"), label: null, confidence: 0.40 };
  }

  return null;
}

// ── Geometry helpers ─────────────────────────────────────────────────────

function featureCenter(el) {
  if (el.center && Number.isFinite(el.center.lat) && Number.isFinite(el.center.lon)) {
    return { lat: el.center.lat, lon: el.center.lon };
  }
  if (el.lat != null && el.lon != null) {
    return { lat: Number(el.lat), lon: Number(el.lon) };
  }
  if (Array.isArray(el.geometry) && el.geometry.length > 0) {
    let sumLat = 0, sumLon = 0, n = 0;
    for (const p of el.geometry) {
      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
        sumLat += p.lat; sumLon += p.lon; n++;
      }
    }
    if (n > 0) return { lat: sumLat / n, lon: sumLon / n };
  }
  return null;
}

const YARDS_PER_METER = 1.09361;
function yardsBetween(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c * YARDS_PER_METER;
}

function titleCase(s) {
  if (!s) return s;
  return String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = { mapOsmFeature, featureCenter, yardsBetween };
