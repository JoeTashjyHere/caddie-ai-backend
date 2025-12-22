// To run locally:
// cd backend
// export OPENAI_API_KEY=sk-xxxx
// node index.js
// Server will run on http://localhost:8080

const express = require("express");
const fetch = require("node-fetch"); // v2
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();

// Enable CORS for iOS simulator
app.use(cors({
  origin: "*", // Allow all origins for development
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Serve uploaded images so the iOS app can display thumbnails
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Configure multer for file uploads
const storage = multer.memoryStorage(); // Store files in memory for now
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept image files
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"), false);
    }
  }
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// MARK: - Memory System Helpers

/**
 * Load all shots from /data/shots.json
 */
function loadShots() {
  try {
    const dataDir = path.join(__dirname, "data");
    const shotsFile = path.join(dataDir, "shots.json");
    
    if (!fs.existsSync(shotsFile)) {
      return [];
    }
    
    const data = fs.readFileSync(shotsFile, "utf8");
    return JSON.parse(data);
  } catch (err) {
    console.error("Error loading shots:", err);
    return [];
  }
}

/**
 * Save shots to /data/shots.json
 */
function saveShots(shots) {
  try {
    const dataDir = path.join(__dirname, "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    const shotsFile = path.join(dataDir, "shots.json");
    fs.writeFileSync(shotsFile, JSON.stringify(shots, null, 2));
    return true;
  } catch (err) {
    console.error("Error saving shots:", err);
    return false;
  }
}

/**
 * Add a shot to the memory system
 */
function addShot(shotData) {
  const shots = loadShots();
  shots.push(shotData);
  saveShots(shots);
}

/**
 * Update feedback for a shot in the memory system
 */
function updateShotFeedback(shotId, feedback) {
  const shots = loadShots();
  const shot = shots.find(s => s.id === shotId);
  if (shot) {
    shot.userFeedback = feedback;
    shot.feedbackTimestamp = new Date().toISOString();
    saveShots(shots);
    return true;
  }
  return false;
}

/**
 * Find relevant shot history based on course, hole, shotType, and club
 */
function findRelevantShots(courseId, holeNumber, shotType, club) {
  const shots = loadShots();
  
  return shots.filter(shot => {
    // Match course
    if (shot.courseId !== courseId) return false;
    
    // Match hole (exact match preferred)
    if (shot.holeNumber === holeNumber) {
      // If we have shotType and club, try to match those too
      if (shotType && shot.shotType !== shotType) return false;
      if (club && shot.recommendation?.club !== club) return false;
      return true;
    }
    
    // Also include shots from same course if no exact hole match
    // This can help with course-specific insights
    return false;
  }).sort((a, b) => {
    // Sort by timestamp (newest first)
    const timeA = new Date(a.timestamp || a.uploadedAt || 0);
    const timeB = new Date(b.timestamp || b.uploadedAt || 0);
    return timeB - timeA;
  });
}

/**
 * Generate insights string from relevant shot history
 */
function generateInsightsFromHistory(relevantShots) {
  if (relevantShots.length === 0) {
    return "";
  }
  
  const insights = [];
  
  // Group by shot type
  const byShotType = {};
  relevantShots.forEach(shot => {
    const type = shot.shotType || "unknown";
    if (!byShotType[type]) {
      byShotType[type] = [];
    }
    byShotType[type].push(shot);
  });
  
  // Generate insights for each shot type
  Object.keys(byShotType).forEach(shotType => {
    const shots = byShotType[shotType];
    const holeNumbers = [...new Set(shots.map(s => s.holeNumber))];
    
    holeNumbers.forEach(holeNum => {
      const holeShots = shots.filter(s => s.holeNumber === holeNum);
      const helpfulCount = holeShots.filter(s => s.userFeedback === "helpful").length;
      const offCount = holeShots.filter(s => s.userFeedback === "off").length;
      const totalWithFeedback = helpfulCount + offCount;
      
      if (totalWithFeedback > 0) {
        const helpfulPct = (helpfulCount / totalWithFeedback) * 100;
        
        if (helpfulPct < 50 && offCount > 0) {
          // More "off" feedback than "helpful" - this is important
          const clubsUsed = [...new Set(holeShots.map(s => s.recommendation?.club).filter(Boolean))];
          insights.push(
            `Previous ${shotType} shots on Hole ${holeNum} received mostly negative feedback (${offCount} off, ${helpfulCount} helpful). ` +
            `Clubs used: ${clubsUsed.join(", ")}. Consider adjusting recommendations.`
          );
        } else if (helpfulPct >= 70 && helpfulCount >= 2) {
          // Mostly positive feedback
          const clubsUsed = [...new Set(holeShots.map(s => s.recommendation?.club).filter(Boolean))];
          insights.push(
            `Previous ${shotType} shots on Hole ${holeNum} received positive feedback (${helpfulCount} helpful, ${offCount} off). ` +
            `Successful clubs: ${clubsUsed.join(", ")}.`
          );
        }
      }
      
      // Check for common patterns in shot context
      const contexts = holeShots.map(s => s.shotContext).filter(Boolean);
      if (contexts.length > 0) {
        const surfaces = [...new Set(contexts.map(c => c.surface).filter(Boolean))];
        const elevations = [...new Set(contexts.map(c => c.conditions?.elevation).filter(Boolean))];
        
        if (elevations.length > 0 && elevations.some(e => e && e.includes("+"))) {
          insights.push(
            `Hole ${holeNum} has uphill elevation (${elevations.filter(e => e && e.includes("+")).length} previous shots). ` +
            `Previous drives on this hole tend to land short. Adjust recommendation accordingly.`
          );
        }
        
        if (surfaces.includes("rough") && holeShots.length >= 2) {
          insights.push(
            `Hole ${holeNum} often has rough conditions (${contexts.filter(c => c.surface === "rough").length} previous shots). ` +
            `Consider club selection for rough lies.`
          );
        }
      }
    });
  });
  
  return insights.join("\n\n");
}

// Local in-memory courses (starter list)
const localCourses = [
  { id: "pebble", name: "Pebble Beach Golf Links", par: 72, lat: 36.568, lon: -121.95 },
  { id: "augusta", name: "Augusta National Golf Club", par: 72, lat: 33.502, lon: -82.021 },
  { id: "st-andrews", name: "St. Andrews Links", par: 72, lat: 56.340, lon: -2.818 },
  { id: "local-muni", name: "Local Public Course", par: 70, lat: 37.7749, lon: -122.4194 },
  { id: "country-club", name: "Country Club Course", par: 71, lat: 37.7849, lon: -122.4094 },
  { id: "riverside", name: "Riverside Golf Club", par: 72, lat: 37.7649, lon: -122.4294 },
  { id: "mountain-view", name: "Mountain View Golf Course", par: 69, lat: 37.7549, lon: -122.4394 }
];

// Helper function to fetch external courses (stub for now)
async function fetchExternalCourses(lat, lon, query) {
  // TODO: Replace with real external API call
  // Examples:
  // - Google Places API: https://developers.google.com/maps/documentation/places/web-service/search
  // - Mapbox Geocoding API: https://docs.mapbox.com/api/search/geocoding/
  // - OpenStreetMap Nominatim: https://nominatim.org/release-docs/develop/api/Search/
  
  // For now, return empty array to trigger fallback
  return [];
  
  // Example implementation structure:
  // try {
  //   const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  //   const response = await fetch(
  //     `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query || 'golf course')}&location=${lat},${lon}&radius=50000&key=${apiKey}`
  //   );
  //   const data = await response.json();
  //   return data.results.map(result => ({
  //     id: result.place_id,
  //     name: result.name,
  //     par: 72, // Would need to fetch from golf course database
  //     lat: result.geometry.location.lat,
  //     lon: result.geometry.location.lng
  //   }));
  // } catch (error) {
  //   console.error("External API error:", error);
  //   return [];
  // }
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// AI Caddie endpoint
app.post("/api/openai/complete", async (req, res) => {
  try {
    const { system, user } = req.body;

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY missing on server");
      return res.status(500).json({ error: "OPENAI_API_KEY missing on server" });
    }
    
    // Parse user payload to extract context for memory lookup
    let courseId = null;
    let holeNumber = null;
    let shotType = null;
    let club = null;
    
    try {
      const userData = typeof user === "string" ? JSON.parse(user) : user;
      courseId = userData.course?.id || userData.courseId;
      holeNumber = userData.hole;
      
      // Try to extract shot type and club from captured shots
      if (userData.capturedShots && Array.isArray(userData.capturedShots) && userData.capturedShots.length > 0) {
        const lastShot = userData.capturedShots[userData.capturedShots.length - 1];
        shotType = lastShot.shotType;
        club = lastShot.recommendation?.club || lastShot.club;
      }
      
      // Also check for shotType directly in payload
      if (!shotType && userData.shotType) {
        shotType = userData.shotType;
      }
    } catch (e) {
      // If parsing fails, continue without memory lookup
      console.log("Could not parse user payload for memory lookup:", e.message);
    }
    
    // Load relevant shot history
    let memoryInsights = "";
    if (courseId && holeNumber) {
      const relevantShots = findRelevantShots(courseId, holeNumber, shotType, club);
      if (relevantShots.length > 0) {
        memoryInsights = generateInsightsFromHistory(relevantShots);
        console.log(`Found ${relevantShots.length} relevant shots for memory system`);
        
        if (memoryInsights) {
          console.log("Memory insights generated:", memoryInsights);
        }
      }
    }
    
    // Enhance system prompt with memory insights
    let enhancedSystem = system;
    if (memoryInsights) {
      enhancedSystem = `${system}\n\n## Previous Shot History and Insights\n\n${memoryInsights}\n\nUse these insights to make smarter, personalized recommendations. Adjust your recommendations based on what has worked or not worked in the past.`;
    }

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        // if this model isn't available to your account,
        // OpenAI will return an error object instead of choices[]
        model: "gpt-4o-mini",
        // you can comment this out if your account doesn't like it:
        // response_format: { type: "json_object" },
        messages: [
          { role: "system", content: enhancedSystem },
          { role: "user", content: typeof user === "string" ? user : JSON.stringify(user) }
        ]
      })
    });

    const data = await r.json();

    // log whatever we got so we can see the real shape
    console.log("OpenAI raw response:", JSON.stringify(data, null, 2));

    // handle OpenAI error shape
    if (data.error) {
      return res.status(500).json({ error: "OpenAI call failed", detail: data.error });
    }

    // handle normal shape
    if (Array.isArray(data.choices) && data.choices.length > 0) {
      const content = data.choices[0].message.content;
      return res.json({ resultJSON: content });
    }

    // fallback
    console.error("Unexpected OpenAI response shape:", data);
    return res.status(500).json({ error: "Unexpected OpenAI response shape", detail: data });
  } catch (err) {
    console.error("Server error in /api/openai/complete:", err);
    // Log error but don't crash - return error response
    res.status(500).json({ error: "OpenAI call failed", detail: String(err) });
  }
});

// Courses endpoint - hybrid approach
app.get("/api/courses", async (req, res) => {
  try {
    const { lat, lon, query } = req.query;

    // 1) Try local in-memory courses first (filtered by query if provided)
    if (query) {
      const filtered = localCourses.filter(c =>
        c.name.toLowerCase().includes(query.toLowerCase())
      );
      if (filtered.length > 0) {
        return res.json({ source: "local", courses: filtered });
      }
    }

    // 2) Try external places API (stub for now)
    try {
      const externalCourses = await fetchExternalCourses(lat, lon, query);
      if (externalCourses.length > 0) {
        return res.json({ source: "external", courses: externalCourses });
      }
    } catch (err) {
      console.error("External course lookup failed:", err);
    }

    // 3) Final fallback: return local list so iOS app always has something to render
    // If we have lat/lon, filter by proximity (optional enhancement)
    let coursesToReturn = localCourses;
    
    if (lat && lon) {
      // Optional: Sort by distance (simple implementation)
      const userLat = parseFloat(lat);
      const userLon = parseFloat(lon);
      
      coursesToReturn = localCourses
        .filter(c => c.lat && c.lon)
        .map(course => ({
          ...course,
          distance: Math.sqrt(
            Math.pow(course.lat - userLat, 2) + Math.pow(course.lon - userLon, 2)
          )
        }))
        .sort((a, b) => a.distance - b.distance)
        .map(({ distance, ...course }) => course);
    }

    return res.json({ source: "fallback-local", courses: coursesToReturn });
  } catch (err) {
    console.error("Error in /api/courses:", err);
    // Even on error, return local courses as fallback
    return res.json({ source: "error-fallback", courses: localCourses });
  }
});

// Feedback endpoint
app.post("/api/feedback/caddie", (req, res) => {
  try {
    const { courseId, hole, suggestedClub, feedback, shotId } = req.body;
    
    console.log("Caddie feedback received:", {
      courseId,
      hole,
      suggestedClub,
      feedback,
      shotId,
      timestamp: new Date().toISOString()
    });
    
    // Store feedback in memory system
    if (shotId) {
      // Try to update existing shot by ID
      updateShotFeedback(shotId, feedback);
    } else {
      // Create a new feedback entry
      const feedbackData = {
        id: `feedback-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        courseId,
        holeNumber: hole,
        suggestedClub,
        userFeedback: feedback,
        feedbackTimestamp: new Date().toISOString(),
        timestamp: new Date().toISOString()
      };
      addShot(feedbackData);
    }
    
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error handling feedback:", err);
    return res.status(500).json({ error: "Failed to process feedback" });
  }
});

/**
 * Image upload endpoint for golf photo analysis
 * 
 * Accepts:
 * - multipart/form-data with field name "photo" (image file)
 * - Additional form fields: playerProfile (JSON string or object), courseId, holeNumber, shotType, lat, lon, learningMode
 * 
 * shotType values: "drive", "approach", "chip", "putt", "recovery"
 * 
 * Returns:
 * - { 
 *     recommendation: { club: string, aim: string, avoid: string, confidence: number },
 *     shotContext: { shotType: string, surface: string, conditions: object }
 *   }
 * 
 * Example:
 * POST /api/photo/analyze
 * Content-Type: multipart/form-data
 * 
 * photo: [image file]
 * playerProfile: {"name": "John", "clubs": [...]}
 * courseId: "pebble"
 * holeNumber: 7
 * shotType: "approach"
 * lat: 37.7749
 * lon: -122.4194
 * learningMode: "true" (optional)
 */
app.post("/api/photo/analyze", upload.single("photo"), async (req, res) => {
  try {
    // Validate required fields
    const {
      playerProfile,
      courseId,
      holeNumber,
      shotType,
      lat,
      lon,
      learningMode,
      club,
      distance
    } = req.body;
    
    if (!playerProfile || !courseId || !holeNumber) {
      return res.status(400).json({ 
        error: "Missing required fields: playerProfile, courseId, and holeNumber are required" 
      });
    }
    
    // Validate file upload
    if (!req.file) {
      return res.status(400).json({ 
        error: "No photo file provided. Expected field name: 'photo'" 
      });
    }
    
    // Validate shotType if provided
    const validShotTypes = ["drive", "approach", "chip", "putt", "recovery"];
    const normalizedShotType = shotType ? shotType.toLowerCase() : "approach";
    if (shotType && !validShotTypes.includes(normalizedShotType)) {
      return res.status(400).json({ 
        error: `Invalid shotType. Must be one of: ${validShotTypes.join(", ")}` 
      });
    }
    
    const timestamp = new Date().toISOString();
    
    const parsedDistance = distance !== undefined && distance !== null && distance !== ""
      ? parseFloat(distance)
      : null;
    const distanceValue = Number.isFinite(parsedDistance) ? parsedDistance : null;

    console.log("Photo upload received:", {
      courseId,
      holeNumber,
      shotType: normalizedShotType,
      lat: lat || "not provided",
      lon: lon || "not provided",
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      club: club || "not provided",
      distance: distanceValue || "not provided",
      learningMode: learningMode === "true" || learningMode === true,
      timestamp
    });
    
    // Image is available in req.file.buffer (memory storage)
    // For now, we'll use it to generate a recommendation
    // In the future, this would call OpenAI Vision API
    
    // Parse playerProfile if it's a JSON string
    let profile;
    try {
      profile = typeof playerProfile === "string" ? JSON.parse(playerProfile) : playerProfile;
    } catch (e) {
      return res.status(400).json({ 
        error: "Invalid playerProfile JSON format" 
      });
    }
    
    // Save image with metadata in course-based subfolder
    const uploadsDir = path.join(__dirname, "uploads");
    const courseDir = path.join(uploadsDir, courseId);
    
    if (!fs.existsSync(courseDir)) {
      fs.mkdirSync(courseDir, { recursive: true });
    }
    
    // Generate filename with metadata
    const timestampForFile = Date.now();
    const filename = `${timestampForFile}-hole${holeNumber}-${normalizedShotType}.jpg`;
    const filepath = path.join(courseDir, filename);
    const imageUrl = `/uploads/${courseId}/${filename}`;
    
    // Save image file
    fs.writeFileSync(filepath, req.file.buffer);
    console.log("Saved image to:", filepath);
    
    // Prepare metadata
    const metadata = {
      timestamp,
      holeNumber: parseInt(holeNumber),
      shotType: normalizedShotType,
      courseId,
      fileName: filename,
      filePath: filepath,
      lat: lat ? parseFloat(lat) : null,
      lon: lon ? parseFloat(lon) : null,
      clubUsed: club || null,
      distance: distanceValue
    };
    
    // Generate a recommendation based on the photo and context
    // For now, return a mock recommendation
    // In production, this would:
    // 1. Convert image buffer to base64
    // 2. Call OpenAI Vision API with the image and context
    // 3. Parse the response and return it
    
    const recommendation = {
      club: normalizedShotType === "putt" ? "Putter" : normalizedShotType === "chip" ? "SW" : "7 iron",
      aim: normalizedShotType === "putt" ? "center cup" : normalizedShotType === "approach" ? "center green" : "center fairway",
      avoid: normalizedShotType === "putt" ? "overshoot" : "left bunker",
      confidence: 0.83
    };
    
    // Update metadata with recommendation
    if (!metadata.clubUsed) {
      metadata.clubUsed = recommendation.club;
    }
    
    // Generate shot context (mock for now - would come from AI analysis)
    const shotContext = {
      shotType: normalizedShotType,
      surface: normalizedShotType === "putt" ? "green" : normalizedShotType === "chip" ? "rough" : "fairway",
      conditions: {
        wind: "light",
        elevation: "+4ft"
      }
    };
    
    // Always store shot data in memory system (not just when learning mode is enabled)
    let shotId = null;
    try {
      const shotData = {
        id: `shot-${timestampForFile}-${Math.random().toString(36).substr(2, 9)}`,
        ...metadata,
        recommendation,
        shotContext,
        uploadedAt: new Date().toISOString(),
        userFeedback: null, // Will be updated when feedback is received
        feedbackTimestamp: null,
        imageUrl
      };
      shotId = shotData.id;
      
      addShot(shotData);
      console.log("Stored shot data in memory system:", shotData.id);
      
      // Return shot ID so client can use it for feedback
      return res.json({
        recommendation,
        shotContext,
        shotId,
        imageUrl
      });
    } catch (err) {
      console.error("Error storing shot data:", err);
      // Don't fail the request if storage fails
      return res.json({
        recommendation,
        shotContext,
        shotId,
        imageUrl
      });
    }
    
  } catch (err) {
    console.error("Error in /api/photo/analyze:", err);
    
    // Handle multer errors
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File too large. Maximum size is 10MB" });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    
    // Handle file system errors
    if (err.code === "ENOENT" || err.code === "EACCES") {
      console.error("File system error:", err.message);
      return res.status(500).json({ error: "Failed to save image file" });
    }
    
    return res.status(500).json({ error: "Failed to process photo upload", detail: String(err) });
  }
});

/**
 * Course Intelligence endpoint
 * 
 * Returns insights about a specific course based on shot history
 * 
 * GET /api/insights/course?courseId=...&userId=...
 * 
 * Returns:
 * - {
 *     courseId: string,
 *     mostPlayedHoles: number[],
 *     trickyHoles: [{ hole: number, avgOverPar: number, note: string }],
 *     clubInsights: [{ club: string, avg: number, profile: number, note: string }],
 *     aiNotes: string[]
 *   }
 */
app.get("/api/insights/course", (req, res) => {
  try {
    const { courseId, userId } = req.query;
    
    if (!courseId) {
      return res.status(400).json({ error: "courseId is required" });
    }
    
    // Load all shots
    const allShots = loadShots();
    
    // Filter shots for this course (and optionally userId if provided)
    const courseShots = allShots.filter(shot => {
      if (shot.courseId !== courseId) return false;
      // If userId is provided, filter by userId (for now, we'll skip this as userId might not be in shots)
      return true;
    });
    
    if (courseShots.length === 0) {
      // Return empty insights object so app can still render
      return res.json({
        courseId,
        mostPlayedHoles: [],
        trickyHoles: [],
        clubInsights: [],
        aiNotes: [],
        holeDetails: []
      });
    }
    
    // Group shots by hole
    const shotsByHole = {};
    courseShots.forEach(shot => {
      const hole = shot.holeNumber;
      if (!shotsByHole[hole]) {
        shotsByHole[hole] = [];
      }
      shotsByHole[hole].push(shot);
    });
    
    // Calculate most played holes (by count of shots)
    const mostPlayedHoles = Object.keys(shotsByHole)
      .map(hole => parseInt(hole))
      .sort((a, b) => {
        const countA = shotsByHole[a].length;
        const countB = shotsByHole[b].length;
        return countB - countA; // Sort descending
      })
      .slice(0, 10); // Top 10 most played
    
    // Calculate tricky holes (holes with most negative feedback or highest scores)
    const trickyHoles = [];
    Object.keys(shotsByHole).forEach(holeNum => {
      const hole = parseInt(holeNum);
      const shots = shotsByHole[hole];
      
      // Count negative feedback
      const negativeFeedback = shots.filter(s => s.userFeedback === "off").length;
      const totalFeedback = shots.filter(s => s.userFeedback).length;
      
      // Calculate average "over par" (simplified - we'll use feedback as proxy)
      // In a real app, we'd calculate actual scores vs par
      let avgOverPar = 0;
      if (totalFeedback > 0) {
        const negativeRatio = negativeFeedback / totalFeedback;
        // If more than 50% negative feedback, consider it tricky
        if (negativeRatio > 0.5) {
          avgOverPar = negativeRatio * 2; // Rough estimate
        }
      }
      
      // Check for common issues in shot context
      const contexts = shots.map(s => s.shotContext).filter(Boolean);
      const elevations = contexts.map(c => c.conditions?.elevation).filter(Boolean);
      const hasUphill = elevations.some(e => e && e.includes("+"));
      
      if (avgOverPar > 0 || hasUphill || negativeFeedback >= 2) {
        let note = "";
        if (hasUphill) {
          note = "Uphill approach, user underclubs";
        } else if (negativeFeedback >= 2) {
          note = `User had difficulty with ${negativeFeedback} previous shots`;
        } else {
          note = "Challenging hole based on shot history";
        }
        
        trickyHoles.push({
          hole,
          avgOverPar: avgOverPar.toFixed(1),
          note
        });
      }
    });
    
    // Sort tricky holes by avgOverPar (descending)
    trickyHoles.sort((a, b) => parseFloat(b.avgOverPar) - parseFloat(a.avgOverPar));
    
    // Calculate club insights
    const clubStats = {};
    courseShots.forEach(shot => {
      const club = shot.recommendation?.club || shot.clubUsed;
      if (!club) return;
      
      if (!clubStats[club]) {
        clubStats[club] = {
          club,
          distances: [],
          shots: []
        };
      }
      
      if (shot.distance) {
        clubStats[club].distances.push(shot.distance);
      }
      clubStats[club].shots.push(shot);
    });
    
    const clubInsights = [];
    Object.keys(clubStats).forEach(club => {
      const stats = clubStats[club];
      if (stats.distances.length === 0) return;
      
      const avg = stats.distances.reduce((sum, d) => sum + d, 0) / stats.distances.length;
      // For now, we'll use a default profile distance (150 yards for most clubs)
      // In a real app, we'd get this from the player profile
      const profile = 150; // Default
      
      const diff = avg - profile;
      let note = "";
      if (diff < -10) {
        note = "User hits this short here";
      } else if (diff > 10) {
        note = "User hits this longer here";
      } else {
        note = "Distance matches profile";
      }
      
      clubInsights.push({
        club,
        avg: Math.round(avg),
        profile,
        note
      });
    });
    
    // Generate AI notes from shot history
    const aiNotes = [];
    
    // Check for common patterns
    const surfaces = {};
    const elevations = {};
    const windConditions = {};
    
    courseShots.forEach(shot => {
      const context = shot.shotContext;
      if (!context) return;
      
      const surface = context.surface;
      if (surface) {
        surfaces[surface] = (surfaces[surface] || 0) + 1;
      }
      
      const elevation = context.conditions?.elevation;
      if (elevation) {
        elevations[elevation] = (elevations[elevation] || 0) + 1;
      }
      
      const wind = context.conditions?.wind;
      if (wind) {
        windConditions[wind] = (windConditions[wind] || 0) + 1;
      }
    });
    
    // Generate notes based on patterns
    const roughCount = surfaces["rough"] || 0;
    if (roughCount >= 3) {
      aiNotes.push("Fairways were soft on your last round.");
    }
    
    // Check for wind patterns on specific holes
    Object.keys(shotsByHole).forEach(holeNum => {
      const hole = parseInt(holeNum);
      const holeShots = shotsByHole[hole];
      const holeWind = {};
      holeShots.forEach(shot => {
        const wind = shot.shotContext?.conditions?.wind;
        if (wind) {
          holeWind[wind] = (holeWind[wind] || 0) + 1;
        }
      });
      
      const intoWind = holeWind["into"] || holeWind["strong"];
      if (intoWind && intoWind >= 3) {
        aiNotes.push(`Wind was into on Hole ${hole} three rounds in a row.`);
      }
    });
    
    // Check for elevation patterns
    const uphillCount = Object.keys(elevations).filter(e => e && e.includes("+")).length;
    if (uphillCount >= 2) {
      aiNotes.push("Course has several uphill holes. Consider club selection.");
    }
    
    // Check for feedback patterns
    const helpfulCount = courseShots.filter(s => s.userFeedback === "helpful").length;
    const offCount = courseShots.filter(s => s.userFeedback === "off").length;
    if (helpfulCount > offCount * 2 && helpfulCount >= 5) {
      aiNotes.push("AI recommendations have been working well on this course.");
    } else if (offCount > helpfulCount && offCount >= 3) {
      aiNotes.push("AI recommendations may need adjustment for this course's conditions.");
    }
    
    // Build hole detail history (latest 5 shots per hole)
    const holeDetails = Object.keys(shotsByHole).map(holeNum => {
      const hole = parseInt(holeNum, 10);
      const holeShots = shotsByHole[hole] || [];
      const sortedShots = holeShots.sort((a, b) => {
        const timeA = new Date(a.timestamp || a.uploadedAt || 0);
        const timeB = new Date(b.timestamp || b.uploadedAt || 0);
        return timeB - timeA;
      });
      
      const shots = sortedShots.slice(0, 5).map(shot => ({
        id: shot.id,
        timestamp: shot.timestamp || shot.uploadedAt,
        shotType: shot.shotType || "approach",
        recommendation: shot.recommendation || null,
        userFeedback: shot.userFeedback || null,
        imageUrl: shot.imageUrl || null,
        club: shot.recommendation?.club || shot.clubUsed || null,
        distance: shot.distance || null,
        shotContext: shot.shotContext || null
      }));
      
      return {
        hole,
        shots
      };
    }).sort((a, b) => a.hole - b.hole);
    
    return res.json({
      courseId,
      mostPlayedHoles,
      trickyHoles,
      clubInsights,
      aiNotes,
      holeDetails
    });
    
  } catch (err) {
    console.error("Error in /api/insights/course:", err);
    // Return empty insights object so app can still render
    return res.json({
      courseId: req.query.courseId || "unknown",
      mostPlayedHoles: [],
      trickyHoles: [],
      clubInsights: [],
      aiNotes: [],
      holeDetails: []
    });
  }
});

/**
 * Putting Analysis endpoint
 * 
 * Analyzes a photo of the green and returns putting read information
 * 
 * POST /api/putting/analyze
 * 
 * Form data:
 * - photo: [image file]
 * - courseId: string
 * - holeNumber: number
 * - lat: number (optional)
 * - lon: number (optional)
 * 
 * Returns:
 * - {
 *     breakDirection: "Left" | "Right" | "Straight",
 *     breakAmount: number (inches),
 *     speed: "Fast" | "Medium" | "Slow",
 *     narrative: string,
 *     puttingLine: string (optional),
 *     imageUrl: string
 *   }
 */
app.post("/api/putting/analyze", upload.single("photo"), async (req, res) => {
  try {
    // Validate required fields
    const { courseId, holeNumber, lat, lon } = req.body;
    
    if (!courseId || !holeNumber) {
      return res.status(400).json({ 
        error: "Missing required fields: courseId and holeNumber are required" 
      });
    }
    
    // Validate file upload
    if (!req.file) {
      return res.status(400).json({ 
        error: "No photo file provided. Expected field name: 'photo'" 
      });
    }
    
    console.log("Putting analysis request:", {
      courseId,
      holeNumber,
      lat: lat || "not provided",
      lon: lon || "not provided",
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype
    });
    
    // Save image with metadata
    const uploadsDir = path.join(__dirname, "uploads");
    const courseDir = path.join(uploadsDir, courseId);
    
    if (!fs.existsSync(courseDir)) {
      fs.mkdirSync(courseDir, { recursive: true });
    }
    
    const timestampForFile = Date.now();
    const filename = `${timestampForFile}-hole${holeNumber}-putting.jpg`;
    const filepath = path.join(courseDir, filename);
    const imageUrl = `/uploads/${courseId}/${filename}`;
    
    // Save image file
    fs.writeFileSync(filepath, req.file.buffer);
    console.log("Saved putting image to:", filepath);
    
    // Convert image to base64 for OpenAI Vision API
    const imageBase64 = req.file.buffer.toString("base64");
    
    // Prepare context for OpenAI
    const context = {
      courseId,
      holeNumber: parseInt(holeNumber),
      lat: lat ? parseFloat(lat) : null,
      lon: lon ? parseFloat(lon) : null,
      analysisType: "putting"
    };
    
    // Call OpenAI Vision API for putting analysis
    let puttingRead;
    if (OPENAI_API_KEY) {
      try {
        const systemPrompt = `You are an expert golf putting analyst. Analyze the green photo and provide a detailed putting read in JSON format.
Return ONLY valid JSON matching this structure:
{
  "breakDirection": "Left" | "Right" | "Straight",
  "breakAmount": 2.5,
  "speed": "Fast" | "Medium" | "Slow",
  "narrative": "Detailed putting read explanation",
  "puttingLine": "Aim 6 inches left of the cup"
}`;

        const userPrompt = `Analyze this putting green photo. Consider:
- Green slope and break direction
- Break amount in inches
- Recommended putting speed
- Optimal putting line
- Any visible grain or slope indicators

Context: Hole ${holeNumber} at ${courseId || "course"}`;

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: systemPrompt
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: userPrompt
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/jpeg;base64,${imageBase64}`
                    }
                  }
                ]
              }
            ],
            max_tokens: 500,
            response_format: { type: "json_object" }
          })
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error("OpenAI API error:", errorText);
          throw new Error(`OpenAI API error: ${response.status}`);
        }
        
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        
        if (!content) {
          throw new Error("No content in OpenAI response");
        }
        
        // Parse JSON response
        const parsed = JSON.parse(content);
        puttingRead = {
          breakDirection: parsed.breakDirection || "Straight",
          breakAmount: parsed.breakAmount || 0,
          speed: parsed.speed || "Medium",
          narrative: parsed.narrative || "Putting analysis completed",
          puttingLine: parsed.puttingLine || "Aim for center of cup"
        };
        
        console.log("OpenAI putting analysis:", puttingRead);
      } catch (openAIError) {
        console.error("Error calling OpenAI for putting analysis:", openAIError);
        // Fallback to mock response
        puttingRead = {
          breakDirection: "Left",
          breakAmount: 2.5,
          speed: "Medium",
          narrative: "Green slopes slightly left to right. Aim 2.5 inches left of the cup. Medium speed recommended.",
          puttingLine: "Aim 2.5 inches left of center"
        };
      }
    } else {
      // No API key - return mock response
      puttingRead = {
        breakDirection: "Left",
        breakAmount: 2.5,
        speed: "Medium",
        narrative: "Green slopes slightly left to right. Aim 2.5 inches left of the cup. Medium speed recommended.",
        puttingLine: "Aim 2.5 inches left of center"
      };
    }
    
    return res.json({
      ...puttingRead,
      imageUrl
    });
    
  } catch (err) {
    console.error("Error in /api/putting/analyze:", err);
    
    // Handle multer errors
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File too large. Maximum size is 10MB" });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    
    return res.status(500).json({ error: "Failed to process putting analysis", detail: String(err) });
  }
});

const PORT = process.env.PORT || 8080;
// Listen on all network interfaces (0.0.0.0) to allow iPhone connections
app.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const networkInterfaces = os.networkInterfaces();
  let localIP = 'localhost';
  
  // Find the first non-internal IPv4 address
  for (const interfaceName in networkInterfaces) {
    const addresses = networkInterfaces[interfaceName];
    for (const addr of addresses) {
      if (addr.family === 'IPv4' && !addr.internal) {
        localIP = addr.address;
        break;
      }
    }
    if (localIP !== 'localhost') break;
  }
  
  console.log(`✅ API running on http://localhost:${PORT}`);
  console.log(`📱 Network URL: http://${localIP}:${PORT}`);
  console.log(`🏥 Health check: http://${localIP}:${PORT}/health`);
  console.log(`\n💡 For iPhone testing, update APIService.swift with IP: ${localIP}`);
  if (!OPENAI_API_KEY) {
    console.warn("⚠️  WARNING: OPENAI_API_KEY not set. AI features will not work.");
  }
});
