"use strict";

/**
 * Tee-relative hazard computation engine.
 *
 * Evaluates each hazard POI relative to a specific tee position:
 *   - distanceFromTee: straight-line yards from tee to hazard
 *   - carryDistance:    yards along the tee→green centerline to the hazard's perpendicular
 *   - lateralOffset:   yards left/right of the centerline (negative = left, positive = right)
 *   - isInPlay:        whether the hazard is reachable based on distance thresholds
 */

const YARDS_TO_METERS = 0.9144;
const METERS_TO_YARDS = 1.09361;

function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Compute hazard relevance relative to a specific tee.
 *
 * @param {{ lat: number, lon: number }} teeCoord - Tee GPS coordinate
 * @param {{ lat: number, lon: number }} greenCoord - Green center GPS coordinate
 * @param {Array<{ poi_type: string, location_label: string, fairway_side: string, lat: number, lon: number }>} hazards - Raw hazard POIs
 * @param {number} holeYardage - Hole yardage from this tee
 * @returns {Array<Object>} Hazards with tee-relative metrics
 */
function computeHazardsForTee(teeCoord, greenCoord, hazards, holeYardage) {
  if (!teeCoord || !greenCoord || !hazards || hazards.length === 0) return [];

  const centerBearing = bearingDeg(teeCoord.lat, teeCoord.lon, greenCoord.lat, greenCoord.lon);
  const holeDistMeters = haversineMeters(teeCoord.lat, teeCoord.lon, greenCoord.lat, greenCoord.lon);

  // Typical max carry distances by skill level (yards) for isInPlay thresholds
  const maxDriveYards = 300; // generous upper bound
  const minRelevantYards = 50; // ignore hazards very close behind tee

  return hazards.map((h) => {
    const hazLat = Number(h.lat);
    const hazLon = Number(h.lon);

    const distFromTeeMeters = haversineMeters(teeCoord.lat, teeCoord.lon, hazLat, hazLon);
    const distFromTeeYards = distFromTeeMeters * METERS_TO_YARDS;

    const bearingToHazard = bearingDeg(teeCoord.lat, teeCoord.lon, hazLat, hazLon);
    const angleDiff = toRad(bearingToHazard - centerBearing);

    // Project hazard onto centerline: carry = cos(angle) * dist, lateral = sin(angle) * dist
    const carryYards = distFromTeeYards * Math.cos(angleDiff);
    const lateralYards = distFromTeeYards * Math.sin(angleDiff);

    // Is the hazard "in play" for this tee?
    const isInPlay =
      carryYards > minRelevantYards &&
      carryYards < holeYardage + 30 &&  // within hole length + overrun
      carryYards <= maxDriveYards + 50 &&  // reachable
      Math.abs(lateralYards) < 80;  // within reasonable lateral range

    return {
      type: h.poi_type,
      locationLabel: h.location_label || null,
      fairwaySide: h.fairway_side || null,
      lat: hazLat,
      lon: hazLon,
      distanceFromTee: Math.round(distFromTeeYards),
      carryDistance: Math.round(carryYards),
      lateralOffset: Math.round(lateralYards),
      isInPlay
    };
  });
}

module.exports = { computeHazardsForTee, haversineMeters, bearingDeg };
