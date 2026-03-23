"use strict";

/**
 * Google Places API integration for course search.
 * All calls from backend only; API key never exposed to client.
 */

const fetch = require("node-fetch");

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const TIMEOUT_MS = 5000;

function getApiKey() {
  if (!GOOGLE_PLACES_API_KEY || !GOOGLE_PLACES_API_KEY.trim()) {
    throw new Error("GOOGLE_PLACES_API_KEY is not set");
  }
  return GOOGLE_PLACES_API_KEY.trim();
}

function timeoutPromise(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Request timeout")), ms)
  );
}

function extractCityState(components) {
  let city = null;
  let state = null;
  if (!Array.isArray(components)) return { city, state };
  for (const c of components) {
    const types = c.types || [];
    if (types.includes("locality")) city = c.long_name || c.short_name;
    if (types.includes("administrative_area_level_1")) state = c.short_name || c.long_name;
  }
  return { city, state };
}

function normalizeSuggestion(prediction, details) {
  const loc = details?.geometry?.location || prediction?.geometry?.location;
  const lat = loc?.lat ?? null;
  const lon = loc?.lng ?? null;
  const { city, state } = extractCityState(details?.address_components || prediction?.address_components);
  return {
    placeId: details?.place_id || prediction?.place_id,
    name: details?.name || prediction?.structured_formatting?.main_text || prediction?.description,
    formattedAddress: details?.formatted_address || null,
    lat,
    lon,
    city,
    state
  };
}

/**
 * Autocomplete - get course suggestions as user types
 * GET /api/courses/autocomplete?query=&lat=&lon=
 */
async function autocomplete(query, lat, lon) {
  const key = getApiKey();
  const input = String(query || "").trim();
  if (!input) return { suggestions: [] };

  let url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&key=${key}`;
  if (lat != null && lon != null && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lon))) {
    url += `&location=${lat},${lon}&radius=50000`;
  }
  url += "&types=establishment";

  const res = await Promise.race([
    fetch(url),
    timeoutPromise(TIMEOUT_MS)
  ]);
  const data = await res.json();

  if (data.status === "REQUEST_DENIED" || data.status === "INVALID_REQUEST") {
    throw new Error(data.error_message || "Google Places API error");
  }
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(data.status || "Unknown error");
  }

  const predictions = data.predictions || [];
  const suggestions = predictions.map((p) => ({
    placeId: p.place_id,
    name: p.structured_formatting?.main_text || p.description,
    formattedAddress: p.description || null,
    lat: null,
    lon: null,
    city: null,
    state: null
  }));
  return { suggestions };
}

/**
 * Place Details - get full details for a place
 * GET /api/courses/details?placeId=
 */
async function getPlaceDetails(placeId) {
  const key = getApiKey();
  const pid = String(placeId || "").trim();
  if (!pid) throw new Error("placeId is required");

  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(pid)}&key=${key}&fields=place_id,name,formatted_address,geometry,address_components`;

  const res = await Promise.race([
    fetch(url),
    timeoutPromise(TIMEOUT_MS)
  ]);
  const data = await res.json();

  if (data.status === "REQUEST_DENIED" || data.status === "INVALID_REQUEST") {
    throw new Error(data.error_message || "Google Places API error");
  }
  if (data.status === "NOT_FOUND") return null;
  if (data.status !== "OK") throw new Error(data.status || "Unknown error");

  const result = data.result;
  if (!result) return null;

  return normalizeSuggestion(null, result);
}

/**
 * Nearby Search - find golf courses near a location
 * GET /api/courses/nearby?lat=&lon=&radius_km=
 */
async function nearbySearch(lat, lon, radiusKm = 10) {
  const key = getApiKey();
  const latVal = parseFloat(lat);
  const lonVal = parseFloat(lon);
  if (isNaN(latVal) || isNaN(lonVal)) throw new Error("lat and lon are required");
  const radiusM = Math.min(Math.max(parseInt(radiusKm, 10) || 10, 1), 50) * 1000;

  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${latVal},${lonVal}&radius=${radiusM}&keyword=golf%20course&key=${key}`;

  const res = await Promise.race([
    fetch(url),
    timeoutPromise(TIMEOUT_MS)
  ]);
  const data = await res.json();

  if (data.status === "REQUEST_DENIED" || data.status === "INVALID_REQUEST") {
    throw new Error(data.error_message || "Google Places API error");
  }
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(data.status || "Unknown error");
  }

  const results = data.results || [];
  const suggestions = results.map((r) => {
    const loc = r.geometry?.location;
    return {
      placeId: r.place_id,
      name: r.name,
      formattedAddress: r.vicinity || null,
      lat: loc?.lat ?? null,
      lon: loc?.lng ?? null,
      city: null,
      state: null
    };
  });
  return { suggestions };
}

module.exports = {
  autocomplete,
  getPlaceDetails,
  nearbySearch,
  getApiKey
};
