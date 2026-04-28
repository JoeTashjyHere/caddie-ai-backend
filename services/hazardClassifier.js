"use strict";

/**
 * Canonical hazard classification for Caddie+ / Caddie.AI.
 *
 * Single source of truth used by:
 *   - /api/course-context (filter + normalized_type field)
 *   - /api/admin/hazard-coverage (audit metrics)
 *   - scripts/audit-hazard-coverage.js (DB audit)
 *
 * Design rules:
 *   - POSITIVE WHITELIST: anything that does not classify into a known
 *     hazard category returns null. This prevents yardage markers,
 *     doglegs, and unknown POI types from being injected into the
 *     decision engine or AI prompt as "hazards".
 *   - SUBTYPES MATTER: greenside vs fairway bunker carry different
 *     decision signals. We preserve the distinction.
 *   - DEFENSIVE TYPING: every input may be null/undefined/non-string.
 */

/** All hazard categories Caddie+ understands. */
const HAZARD_TYPES = Object.freeze({
  WATER: "water",
  POND_LAKE: "pond_lake",
  CREEK_STREAM: "creek_stream",
  PENALTY_AREA: "penalty_area",
  BUNKER_FAIRWAY: "bunker_fairway",
  BUNKER_GREENSIDE: "bunker_greenside",
  BUNKER_GENERIC: "bunker",
  TREES: "trees",
  OUT_OF_BOUNDS: "out_of_bounds",
  ROUGH: "rough",
  FAIRWAY_HAZARD: "fairway_hazard",
  OTHER_HAZARD: "other"
});

/** Severity weight used by audit scoring + decision engine fallback. */
const HAZARD_SEVERITY = Object.freeze({
  [HAZARD_TYPES.WATER]: 1.0,
  [HAZARD_TYPES.POND_LAKE]: 1.0,
  [HAZARD_TYPES.CREEK_STREAM]: 0.85,
  [HAZARD_TYPES.PENALTY_AREA]: 0.9,
  [HAZARD_TYPES.OUT_OF_BOUNDS]: 1.0,
  [HAZARD_TYPES.BUNKER_FAIRWAY]: 0.55,
  [HAZARD_TYPES.BUNKER_GREENSIDE]: 0.45,
  [HAZARD_TYPES.BUNKER_GENERIC]: 0.5,
  [HAZARD_TYPES.TREES]: 0.35,
  [HAZARD_TYPES.ROUGH]: 0.2,
  [HAZARD_TYPES.FAIRWAY_HAZARD]: 0.4,
  [HAZARD_TYPES.OTHER_HAZARD]: 0.25
});

/**
 * Lower-cased substring rules. Order matters — first match wins, so
 * more-specific rules (e.g. "fairway bunker") must precede generic
 * rules (e.g. "bunker"). Matching is on a normalized concatenation of
 * (rawType + " " + rawLabel + " " + notes).
 */
const RULES = [
  // Bunkers — subtype-aware
  { match: ["fairway bunker"], type: HAZARD_TYPES.BUNKER_FAIRWAY },
  { match: ["greenside bunker", "green bunker", "greens bunker"], type: HAZARD_TYPES.BUNKER_GREENSIDE },
  { match: ["bunker", "sand trap", "sand bunker"], type: HAZARD_TYPES.BUNKER_GENERIC },
  { match: ["sand"], type: HAZARD_TYPES.BUNKER_GENERIC, requiresHazardCue: true },

  // Water variants
  { match: ["pond"], type: HAZARD_TYPES.POND_LAKE },
  { match: ["lake"], type: HAZARD_TYPES.POND_LAKE },
  { match: ["creek", "stream", "ditch"], type: HAZARD_TYPES.CREEK_STREAM },
  { match: ["water"], type: HAZARD_TYPES.WATER },

  // Out of bounds / boundary / functional OB
  { match: ["out of bounds", "out-of-bounds", " ob ", " ob.", "(ob)", "ob hazard"], type: HAZARD_TYPES.OUT_OF_BOUNDS },
  { match: ["fence", "boundary", "wall", "cart path", "road", "cart road"], type: HAZARD_TYPES.OUT_OF_BOUNDS },

  // Penalty area (modern USGA term — generic)
  { match: ["penalty area", "lateral hazard", "red stake", "yellow stake"], type: HAZARD_TYPES.PENALTY_AREA },

  // Trees / vegetation
  { match: ["trees", "tree", "woods", "forest", "bushes", "shrubs"], type: HAZARD_TYPES.TREES },

  // Generic fairway hazards
  { match: ["fairway hazard", "waste area", "native area"], type: HAZARD_TYPES.FAIRWAY_HAZARD },

  // Rough — only emit if explicitly heavy/long
  { match: ["thick rough", "deep rough", "long grass", "fescue", "tall fescue"], type: HAZARD_TYPES.ROUGH }
];

/**
 * Inputs that are explicitly NOT hazards. Returning null short-circuits
 * the rule scan and keeps these out of the hazard payload.
 */
const NON_HAZARD_TYPES = new Set([
  "tee",
  "tee front",
  "tee back",
  "tee left",
  "tee right",
  "green",
  "green front",
  "green back",
  "green center",
  "green centre",
  "fairway",
  "fairway center",
  "100 marker",
  "150 marker",
  "200 marker",
  "100 yard marker",
  "150 yard marker",
  "200 yard marker",
  "marker",
  "yardage marker",
  "yardage",
  "dogleg",
  "dog leg",
  "aiming point",
  "aim point",
  "target",
  "layup",
  "lay-up",
  "center fairway",
  "centre fairway"
]);

function lc(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function combinedText(rawType, rawLabel, notes) {
  // Pad with leading/trailing spaces so word-boundary patterns like " ob " match
  // even when the raw token is the entire string.
  const joined = `${lc(rawType)} ${lc(rawLabel)} ${lc(notes)}`.replace(/\s+/g, " ").trim();
  return ` ${joined} `;
}

/**
 * Quick test: is this POI a hazard at all?
 * Use this to FILTER before any heavy work (e.g. tee-relative geometry).
 */
function isHazardPoi(rawType, rawLabel = null, side = null, notes = null) {
  return normalizeHazardType(rawType, rawLabel, side, notes) !== null;
}

/**
 * Classify a POI into a canonical hazard category.
 * @param {string} rawType   e.g. "Fairway Bunker", "Water", "Dogleg"
 * @param {string|null} rawLabel  e.g. "F" (Front), "B" (Back), "C" (Center)
 * @param {string|null} side e.g. "L" / "R" / "C"
 * @param {string|null} notes free-form description (rarely populated)
 * @returns {string|null} normalized type or null if not a hazard
 */
function normalizeHazardType(rawType, rawLabel = null, side = null, notes = null) {
  const typeLc = lc(rawType);
  if (!typeLc) return null;

  if (NON_HAZARD_TYPES.has(typeLc)) return null;

  const haystack = combinedText(rawType, rawLabel, notes);

  for (const rule of RULES) {
    for (const pattern of rule.match) {
      if (haystack.includes(pattern)) {
        if (rule.requiresHazardCue) {
          // "sand" alone is too generic; only treat as bunker if
          // accompanied by a hazardish word.
          if (!/(bunker|trap|hazard|waste)/.test(haystack)) continue;
        }
        return rule.type;
      }
    }
  }

  return null;
}

/**
 * Coarse category for analytics drill-downs (collapses subtypes).
 */
function coarseCategory(normalizedType) {
  switch (normalizedType) {
    case HAZARD_TYPES.WATER:
    case HAZARD_TYPES.POND_LAKE:
    case HAZARD_TYPES.CREEK_STREAM:
    case HAZARD_TYPES.PENALTY_AREA:
      return "water";
    case HAZARD_TYPES.BUNKER_FAIRWAY:
    case HAZARD_TYPES.BUNKER_GREENSIDE:
    case HAZARD_TYPES.BUNKER_GENERIC:
      return "bunker";
    case HAZARD_TYPES.TREES:
      return "trees";
    case HAZARD_TYPES.OUT_OF_BOUNDS:
      return "out_of_bounds";
    case HAZARD_TYPES.ROUGH:
    case HAZARD_TYPES.FAIRWAY_HAZARD:
    case HAZARD_TYPES.OTHER_HAZARD:
      return "other";
    default:
      return "other";
  }
}

/**
 * Score a course's hazard data quality 0–100 for the admin dashboard.
 *
 * Components (matches the user-spec weighting):
 *   - 40 pts: holes with at least one usable hazard
 *   - 25 pts: bunker coverage (holes with bunkers / total holes)
 *   - 20 pts: water/penalty coverage (holes with water/penalty / total)
 *   - 15 pts: coordinate completeness (POIs with valid lat/lon / total)
 *
 * @param {object} stats
 * @param {number} stats.totalHoles
 * @param {number} stats.holesWithHazards
 * @param {number} stats.holesWithBunkers
 * @param {number} stats.holesWithWater
 * @param {number} stats.totalPois
 * @param {number} stats.poisWithCoords
 * @returns {{score:number, status:'strong'|'moderate'|'weak'|'poor'|'none'}}
 */
function computeCoverageScore(stats) {
  const totalHoles = Number(stats.totalHoles) || 0;
  if (totalHoles === 0) {
    return { score: 0, status: "none" };
  }
  const safeRatio = (n, d) => (d > 0 ? Math.min(1, Math.max(0, n / d)) : 0);

  const hazardCoverage = safeRatio(stats.holesWithHazards, totalHoles);
  const bunkerCoverage = safeRatio(stats.holesWithBunkers, totalHoles);
  const waterCoverage  = safeRatio(stats.holesWithWater,   totalHoles);
  const coordCompleteness = stats.totalPois > 0
    ? safeRatio(stats.poisWithCoords, stats.totalPois)
    : 0;

  const raw = (hazardCoverage * 40)
            + (bunkerCoverage * 25)
            + (waterCoverage  * 20)
            + (coordCompleteness * 15);

  const score = Math.round(Math.max(0, Math.min(100, raw)));

  let status;
  if (stats.holesWithHazards === 0) status = "none";
  else if (score >= 80) status = "strong";
  else if (score >= 50) status = "moderate";
  else if (score >= 20) status = "weak";
  else status = "poor";

  return { score, status };
}

/**
 * Per-hole coverage status (used by the admin per-hole detail endpoint).
 */
function holeCoverageStatus(hole) {
  if (!hole || hole.hazardCount === 0) return "none";
  // Strong: bunkers AND (water OR trees) AND >=2 hazards
  if (hole.hasBunker && (hole.hasWater || hole.hasTrees) && hole.hazardCount >= 2) return "strong";
  if (hole.hazardCount >= 2) return "moderate";
  return "weak";
}

module.exports = {
  HAZARD_TYPES,
  HAZARD_SEVERITY,
  NON_HAZARD_TYPES,
  isHazardPoi,
  normalizeHazardType,
  coarseCategory,
  computeCoverageScore,
  holeCoverageStatus
};
