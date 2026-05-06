require('dotenv').config({path: ".env"});
const {Pool} = require('pg');

const express = require('express');

const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const app = express();

// MIDDLEWARE

app.use(express.json());
app.use(cors());

// DATABASE CONNECTION POOL

const pool = new Pool({
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('Database connection failed:', err.message);
    } else {
        console.log('Database connected');
    }
});


// DATA PROCESSING

const REPORT_WINDOW = 90;
const MIN_REPORTS = 2;
const NOISE = {
    LOW:    { max: 3.5, label: 'low' },
    MEDIUM: { max: 6,   label: 'medium' },
    HIGH:   { min: 7,   label: 'high' }
};
const CONFIDENCE = { HIGH: 0.75, MEDIUM: 0.50, LOW: 0.25 };
const AMENITY_EXPIRED_CONFIRMATION = 48;
const STALE_DISCLAIMER_DAYS     = 30;
const STALE_LOW_CONFIDENCE_DAYS = 60;

function noiseLevel(level) {
    if (level <= NOISE.LOW.max)    return NOISE.LOW.label;
    if (level <= NOISE.MEDIUM.max) return NOISE.MEDIUM.label;
    return NOISE.HIGH.label;
}

function getTimeWindow(date = new Date()) {
    const hour = date.getHours();
    if (hour >= 5  && hour < 12) return 'Morning';
    if (hour >= 12 && hour < 17) return 'Afternoon';
    if (hour >= 17 && hour < 21) return 'Evening';
    return 'night';
}

function getTimeRelevancy(reportTimestamps) {
    if (!reportTimestamps || reportTimestamps.length === 0) {
        return { status: 'No data', disclaimer: 'No data available for this location', freshnessConfidence: 0.0 };
    }
    const MS_PER_DAY = 86400000;
    const now = Date.now();
    let weightedSum = 0, totalWeight = 0;
    reportTimestamps.forEach((timestamp, index) => {
        const weight = index + 1;
        const daysOld = (now - new Date(timestamp)) / MS_PER_DAY;
        weightedSum += daysOld * weight;
        totalWeight += weight;
    });
    const weightedAvgDays = weightedSum / totalWeight;
    if (weightedAvgDays <= STALE_DISCLAIMER_DAYS) {
        return { status: 'fresh data', disclaimer: null, freshnessConfidence: 1.0, avgDaysOld: Math.round(weightedAvgDays) };
    }
    if (weightedAvgDays <= STALE_LOW_CONFIDENCE_DAYS) {
        return { status: 'more than 1 month old data', disclaimer: `Data is on average ${Math.round(weightedAvgDays)} days old, conditions may have changed`, freshnessConfidence: 0.6, avgDaysOld: Math.round(weightedAvgDays) };
    }
    return { status: 'outdated', disclaimer: `low confidence, data is on average ${Math.round(weightedAvgDays)} days old`, freshnessConfidence: 0.3, avgDaysOld: Math.round(weightedAvgDays) };
}

async function processingVolatileAttributes(locationId, conflictNoiseLabel = null) {
    const result = await pool.query(`
        SELECT AVG(noise_level)::DECIMAL(5,2) AS avg_noise,
            MODE() WITHIN GROUP (ORDER BY crowd_level) AS avg_crowd,
               COUNT(*) AS report_count,
               ARRAY_AGG(report_timestamp ORDER BY report_timestamp ASC) AS timestamps
        FROM user_reports
        WHERE location_id = $1
          AND report_timestamp >= NOW() - INTERVAL '${REPORT_WINDOW} minutes'
          AND noise_level IS NOT NULL
    `, [locationId]);
    const reportCount = parseInt(result.rows[0].report_count);
    if (reportCount < MIN_REPORTS) {
        const historicalDataResult = await pool.query(`
            SELECT avg_noise_level, avg_crowd_level, report_confidence, last_updated
            FROM location_states WHERE location_id = $1 ORDER BY last_updated DESC LIMIT 1
        `, [locationId]);
        const historicalTimestampsResult = await pool.query(`
            SELECT report_timestamp FROM user_reports WHERE location_id = $1 ORDER BY report_timestamp ASC
        `, [locationId]);
        const historicalTimeStamps = historicalTimestampsResult.rows.map(r => r.report_timestamp);
        const timeRelevancy = getTimeRelevancy(historicalTimeStamps);
        return {
            updated: false,
            reason: `Only ${reportCount} recent report(s) - need at least ${MIN_REPORTS}`,
            reportCount,
            historicalData: historicalDataResult.rows[0] ? {
                noise: parseFloat(historicalDataResult.rows[0].avg_noise_level).toFixed(1),
                crowd: historicalDataResult.rows[0].avg_crowd_level,
                reportConfidence: parseFloat(historicalDataResult.rows[0].report_confidence)
            } : null,
            timeRelevancy
        };
    }
    const row = result.rows[0];
    const avgNoise = row.avg_noise, crowdLevel = row.avg_crowd, timeWindow = getTimeWindow();
    const reportConfidence = Math.min(1.0, reportCount / 5).toFixed(2);
    const timeRelevancy = getTimeRelevancy(result.rows[0].timestamps);
    await pool.query(`
        INSERT INTO location_states (location_id, time_window, avg_noise_level, avg_crowd_level, report_count,
                                     last_updated, report_confidence, conflict_noise_label, freshness_confidence)
        VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
            ON CONFLICT (location_id, time_window) DO UPDATE SET
            avg_noise_level      = EXCLUDED.avg_noise_level,
                                                          avg_crowd_level      = EXCLUDED.avg_crowd_level,
                                                          report_count         = EXCLUDED.report_count,
                                                          last_updated         = NOW(),
                                                          report_confidence    = EXCLUDED.report_confidence,
                                                          conflict_noise_label = EXCLUDED.conflict_noise_label,
                                                          freshness_confidence = EXCLUDED.freshness_confidence
    `, [locationId, timeWindow, avgNoise, crowdLevel, reportCount, reportConfidence, conflictNoiseLabel, timeRelevancy.freshnessConfidence]);
    return { updated: true, reportCount, noise: avgNoise, noiseLabel: `${avgNoise} - ${noiseLevel(parseFloat(avgNoise))}`, crowd: crowdLevel, timeWindow, reportConfidence, timeRelevancy };
}

async function processStableAttributes(locationId) {
    const amenitiesResult = await pool.query(`
        SELECT a.amenity_id, a.available_count, a.last_verified, at.amenity_name
        FROM amenities a JOIN amenity_types at ON a.amenity_type_id = at.amenity_type_id
        WHERE location_id = $1
    `, [locationId]);
    const updates = [];
    for (const amenity of amenitiesResult.rows) {
        const hoursSinceLastUpdated = (Date.now() - new Date(amenity.last_verified)) / 36e5;
        const isStale = Math.abs(hoursSinceLastUpdated) > AMENITY_EXPIRED_CONFIRMATION;
        const hoursAbs = Math.abs(hoursSinceLastUpdated);
        const timeAgoLabel = hoursAbs >= 24 ? `${Math.round(hoursAbs / 24)} days ago` : `${hoursAbs.toFixed(1)}h ago`;
        if (!isStale) { updates.push({ amenity_id: amenity.amenity_id, amenity_name: amenity.amenity_name, available_count: amenity.available_count, status: 'skipped', reason: `Last verified ${timeAgoLabel}` }); continue; }
        const stateResult = await pool.query(`SELECT report_confidence FROM location_states WHERE location_id = $1 ORDER BY last_updated DESC LIMIT 1`, [locationId]);
        const reportConfidence = parseFloat(stateResult.rows[0]?.report_confidence ?? 0);
        if (reportConfidence < CONFIDENCE.LOW) { updates.push({ amenity_id: amenity.amenity_id, amenity_name: amenity.amenity_name, status: 'uncertain', reason: 'Low overall location confidence' }); continue; }
        await pool.query(`UPDATE amenities SET last_verified = NOW() WHERE amenity_id = $1`, [amenity.amenity_id]);
        updates.push({ amenity_id: amenity.amenity_id, amenity_name: amenity.amenity_name, available_count: amenity.available_count, status: 'refreshed', reason: `Was outdated (${timeAgoLabel}), re-verified` });
    }
    return { locationId, updates };
}

async function resolveConflict(locationId) {
    const result = await pool.query(`
        SELECT noise_level, report_timestamp FROM user_reports
        WHERE location_id = $1 AND report_timestamp >= NOW() - INTERVAL '${REPORT_WINDOW} minutes' AND noise_level IS NOT NULL
        ORDER BY report_timestamp DESC
    `, [locationId]);
    if (result.rows.length === 0) return { locationId, conflict: false, reason: 'No recent reports' };
    const noiseLevels = result.rows.map(r => r.noise_level);
    const sorted = [...noiseLevels].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length * 0.50)];
    const percent95 = sorted[Math.floor(sorted.length * 0.95)];
    return { locationId, reportCount: result.rows.length, median, percent95, noiseLabel: noiseLevel(percent95), strategy: 'percentile based', interpretation: `The 95th percentile noise level is ${percent95}, labeled as ${noiseLevel(percent95)}` };
}

async function analyzeLocation(locationId) {
    const conflictResult = await resolveConflict(locationId);
    const conflictNoiseLabel = conflictResult.noiseLabel || null;
    const [volatileResult, stableResult] = await Promise.all([
        processingVolatileAttributes(locationId, conflictNoiseLabel),
        processStableAttributes(locationId)
    ]);
    return {
        locationId,
        analyzedAt: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }),
        timeWindow: getTimeWindow(),
        volatileAttributes: volatileResult,
        stableAttributes: stableResult,
        conflictResolution: conflictResult
    };
}

async function runDemo() {
    try {
        const locations = await pool.query(
            'SELECT location_id, name FROM locations ORDER BY location_id'
        );
        const allResults = [];
        for (const loc of locations.rows) {
            console.log(`Analyzing: ${loc.name}...`);
            const result = await analyzeLocation(loc.location_id);
            allResults.push({locationName: loc.name, ...result});
        }
        console.log(JSON.stringify(allResults, null, 2));
    } catch (error) {
        console.error("Analysis failed", error);
    }
}

// JWT CONFIG

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;

// In-memory refresh token store — swap for a DB table in production

// JWT MIDDLEWARE

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

    if (!token) return res.status(401).json({ error: 'Access token required' });

    jwt.verify(token, ACCESS_TOKEN_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user; // { user_id, email }
        next();
    });
}

// BASIC ENDPOINTS

app.get('/api/health', (req, res) => {
    res.json({ status: 'Server is running', timestamp: new Date() });
});

app.get('/api/test', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({
            message: 'Backend connected to database!',
            time: result.rows[0].now
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// AUTH ENDPOINTS

// Register — hash password with bcrypt, insert into users table
app.post('/api/register', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        // Check if email already exists
        const existing = await pool.query(
            'SELECT user_id FROM users WHERE email = $1',
            [email]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        const password_hash = await bcrypt.hash(password, 12);

        const result = await pool.query(
            `INSERT INTO users (email, password_hash, created_at)
             VALUES ($1, $2, NOW())
                 RETURNING user_id, email, created_at`,
            [email, password_hash]
        );

        res.status(201).json({
            message: 'Registered successfully',
            user: result.rows[0]
        });

    } catch (err) {
        console.error('Error registering user:', err);
        res.status(500).json({ error: 'Failed to register user' });
    }
});

// Login — verify bcrypt hash, issue access + refresh tokens
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const result = await pool.query(
            'SELECT user_id, email, password_hash FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Update last_login timestamp
        await pool.query(
            'UPDATE users SET last_login = NOW() WHERE user_id = $1',
            [user.user_id]
        );

        const payload = { user_id: user.user_id, email: user.email };

        // Short-lived access token (24 hr)
        const accessToken = jwt.sign(payload, ACCESS_TOKEN_SECRET, { expiresIn: '24h' });

        // Long-lived refresh token (7 days)
        const refreshToken = jwt.sign(payload, REFRESH_TOKEN_SECRET, { expiresIn: '7d' });

        res.json({ accessToken, refreshToken });

    } catch (err) {
        console.error('Error logging in:', err);
        res.status(500).json({ error: 'Failed to login' });
    }
});

// Refresh — issue a new access token using a valid refresh token
app.post('/api/token', (req, res) => {
    const { token } = req.body;

    if (!token) return res.status(401).json({ error: 'Refresh token required' });

    jwt.verify(token, REFRESH_TOKEN_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired refresh token' });

        const accessToken = jwt.sign(
            { user_id: user.user_id, email: user.email },
            ACCESS_TOKEN_SECRET,
            { expiresIn: '24h' }
        );

        res.json({ accessToken });
    });
});

// Logout — invalidate refresh token
app.delete('/api/logout', (req, res) => {
    res.status(204).send();
});

// LOCATION ENDPOINTS

app.get('/api/locations', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM locations ORDER BY name');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching locations:', err);
        res.status(500).json({ error: 'Failed to fetch locations' });
    }
});

app.get('/api/locations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'SELECT * FROM locations WHERE location_id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Location not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching location:', err);
        res.status(500).json({ error: 'Failed to fetch location' });
    }
});

// AMENITY TYPE ENDPOINTS

app.get('/api/amenity_types', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM amenity_types'
        );
        res.json(result.rows);
    }
    catch (err) {
        console.error('Error fetching amenity types: ', err);
        res.status(500).json({error: 'Failed to fetch amenity types'});
    }
});

app.get('/api/amenity_types/:id', async (req, res) => {
    try {
        const {id} = req.params;
        const result = await pool.query(
            'SELECT * FROM amenity_types WHERE amenity_type_id = $1',
            [id]
        );
        res.json(result.rows);
    }
    catch (err) {
        console.error('Error fetching amenity type: ', err);
        res.status(500).json({error: 'Failed to fetch amenity type'});
    }
});

// LOCATION AMENITY ENDPOINTS

app.get('/api/amenities', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM amenities'
        );
        res.json(result.rows);
    }
    catch (err) {
        console.error('Error fetching amenities: ', err);
        res.status(500).json({error: 'Failed to fetch amenities'});
    }
});

// ID corresponds to location_id, showing all amenities for one location
app.get('/api/amenities/:id', async (req, res) => {
    try {
        const {id} = req.params;
        const result = await pool.query(
            'SELECT * FROM amenities WHERE location_id = $1',
            [id]
        );
        res.json(result.rows);
    }
    catch (err) {
        console.error('Error fetching amenities: ', err);
        res.status(500).json({error: 'Failed to fetch amenities'});
    }
});

app.post('/api/amenities', async (req, res) => {
    try {
        const {location_id, amenity_type_id, available_count} = req.body;

        if (!location_id || !amenity_type_id) {
            return res.status(400).json({error: 'Missing required fields'});
        }

        const location = await pool.query(
            'SELECT name FROM locations WHERE location_id = $1',
            [location_id]
        );
        if (location.rows.length === 0) {
            return res.status(404).json({error: 'Location not found'});
        }

        const amenity = await pool.query(
            'SELECT amenity_name FROM amenity_types WHERE amenity_type_id = $1',
            [amenity_type_id]
        )
        if (amenity.rows.length === 0) {
            return res.status(404).json({error: 'Amenity type not found'});
        }

        const location_amenity = await pool.query(`
                    SELECT amenity_id FROM amenities
                    WHERE location_id = $1 AND amenity_type_id = $2
            `,
            [location_id, amenity_type_id]
        );
        if (location_amenity.rows.length !== 0) {
            return res.status(409).json({error: 'Amenity type already defined for location'});
        }

        const result = await pool.query(`
                    INSERT INTO amenities (location_id, amenity_type_id, available_count)
                    VALUES ($1, $2, $3)
                        RETURNING *
            `,
            [location_id, amenity_type_id, available_count || 0]
        );
        res.status(201).json({
            message: 'Location amenity successfully posted',
            location_amenity: result.rows[0]
        });
    }
    catch (err) {
        console.error('Error posting to location amenities: ', err);
        res.status(500).json({error: 'Failed to post to location amenities'});
    }
});

// USER PREFERENCES ENDPOINTS

// Get preferences for the logged-in user (uses JWT to identify user)
app.get('/api/user_preferences/me', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id;
        const result = await pool.query(
            'SELECT * FROM user_preferences WHERE user_id = $1',
            [user_id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching preferences:', err);
        res.status(500).json({ error: 'Failed to fetch preferences' });
    }
});

// Get required amenities for the logged-in user
app.get('/api/user_required_amenities/me', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id;
        const result = await pool.query(`
            SELECT ura.user_preferred_id, ura.amenity_type_id, ura.priority, at.amenity_name
            FROM user_required_amenities ura
                     JOIN amenity_types at ON ura.amenity_type_id = at.amenity_type_id
            WHERE ura.user_id = $1
        `, [user_id]);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching user amenities:', err);
        res.status(500).json({ error: 'Failed to fetch user amenities' });
    }
});

// Delete preferences for logged-in user
app.delete('/api/user_preferences/me', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id;
        await pool.query(
            'DELETE FROM user_preferences WHERE user_id = $1',
            [user_id]
        );
        res.json({ message: 'Preferences cleared successfully' });
    } catch (err) {
        console.error('Error deleting preferences:', err);
        res.status(500).json({ error: 'Failed to delete preferences' });
    }
});

// Delete required amenities for logged-in user
app.delete('/api/user_required_amenities/me', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id;
        await pool.query(
            'DELETE FROM user_required_amenities WHERE user_id = $1',
            [user_id]
        );
        res.json({ message: 'User amenities cleared successfully' });
    } catch (err) {
        console.error('Error deleting user amenities:', err);
        res.status(500).json({ error: 'Failed to delete user amenities' });
    }
});

app.get('/api/user_preferences', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM user_preferences'
        );
        res.json(result.rows);
    }
    catch (err) {
        console.error('Error fetching preferences: ', err);
        res.status(500).json({error: 'Failed to fetch preferences'});
    }
});

// ID corresponds to user_id, showing all preferences of a user
app.get('/api/user_preferences/:id', async (req, res) => {
    try {
        const {id} = req.params;
        const result = await pool.query(
            'SELECT * FROM user_preferences WHERE user_id = $1',
            [id]
        );
        res.json(result.rows);
    }
    catch (err) {
        console.error('Error fetching preferences: ', err);
        res.status(500).json({error: 'Failed to fetch preferences'});
    }
});

app.post('/api/user_preferences', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id; // from JWT — not from body
        const {noise_level, crowd_level} = req.body;

        if (!noise_level || !crowd_level) {
            return res.status(400).json({error: 'Missing required fields: noise_level and crowd_level'});
        }

        if (noise_level < 1 || noise_level > 10) {
            return res.status(400).json({error: 'Noise level must be between 1 and 10'});
        }

        const result = await pool.query(`
                    INSERT INTO user_preferences (user_id, noise_level, crowd_level)
                    VALUES ($1, $2, $3)
                        RETURNING *
            `,
            [user_id, noise_level, crowd_level]
        );
        res.status(201).json({
            message: 'User preferences successfully posted',
            user_preferences: result.rows[0]
        });
    }
    catch (err) {
        console.error('Error posting user preferences: ', err);
        res.status(500).json({error: 'Failed to post user preferences'});
    }
});

// USER REQUIRED AMENITIES ENDPOINTS

app.get('/api/user_required_amenities', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM user_required_amenities'
        );
        res.json(result.rows);
    }
    catch (err) {
        console.error('Error fetching user amenities: ', err);
        res.status(500).json({error: 'Failed to fetch user amenities'});
    }
});

// ID corresponds to user_preferred_id
app.get('/api/user_required_amenities/:id', async (req, res) => {
    try {
        const {id} = req.params;
        const result = await pool.query(
            'SELECT * FROM user_required_amenities WHERE user_preferred_id = $1',
            [id]
        );
        res.json(result.rows);
    }
    catch (err) {
        console.error('Error fetching user amenities: ', err);
        res.status(500).json({error: 'Failed to fetch user amenities'});
    }
});

app.post('/api/user_required_amenities', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id;
        const {amenity_type_id, priority} = req.body;

        if (!amenity_type_id || !priority) {
            return res.status(400).json({error: 'Missing required fields: amenity_type_id and priority'});
        }

        const amenity_type = await pool.query(
            'SELECT amenity_name FROM amenity_types WHERE amenity_type_id = $1',
            [amenity_type_id]
        );
        if (amenity_type.rows.length === 0) {
            return res.status(404).json({error: 'Amenity type not found'});
        }

        const result = await pool.query(`
            INSERT INTO user_required_amenities (user_id, amenity_type_id, priority)
            VALUES ($1, $2, $3)
                RETURNING *
        `, [user_id, amenity_type_id, priority]);

        res.status(201).json({
            message: 'User required amenities successfully posted',
            user_required_amenities: result.rows[0]
        });
    }
    catch (err) {
        console.error('Error posting user required amenities: ', err);
        res.status(500).json({error: 'Failed to post user required amenities'});
    }
});

// RECOMMENDATION ENDPOINTS

app.get('/api/recommendations', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM recommendations'
        );
        res.json(result.rows);
    }
    catch (err) {
        console.error('Error fetching recommendations: ', err);
        res.status(500).json({error: 'Failed to fetch recommendations'});
    }
});

// GET /api/recommendations/generate CB 2
// Pulls the logged-in user's saved preferences from the DB,
// scores all locations against them, and returns a ranked list.
app.get('/api/recommendations/generate', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id;

        // Get user noise preference
        const prefResult = await pool.query(
            'SELECT noise_level, crowd_level FROM user_preferences WHERE user_id = $1 ORDER BY preference_id DESC LIMIT 1',
            [user_id]
        );

        // Get user required amenities
        const amenityPrefResult = await pool.query(`
            SELECT at.amenity_name
            FROM user_required_amenities ura
                     JOIN amenity_types at ON ura.amenity_type_id = at.amenity_type_id
            WHERE ura.user_id = $1
        `, [user_id]);

        const requiredAmenities = amenityPrefResult.rows.map(r => r.amenity_name.toLowerCase());

        // Get all locations with avg noise from recent reports + most recent crowd level from location_states
        const locationResult = await pool.query(`
            SELECT
                l.location_id,
                l.name,
                l.address,
                AVG(ur.noise_level) FILTER (WHERE ur.report_timestamp > NOW() - INTERVAL '365 days') as avg_noise,
                ls.avg_crowd_level as crowd_level
            FROM locations l
                     LEFT JOIN user_reports ur ON l.location_id = ur.location_id
                     LEFT JOIN LATERAL (
                SELECT avg_crowd_level
                FROM location_states
                WHERE location_id = l.location_id
                ORDER BY last_updated DESC
                    LIMIT 1
                     ) ls ON true
            GROUP BY l.location_id, l.name, l.address, ls.avg_crowd_level
            ORDER BY l.location_id
        `);

        // Get all available amenities per location
        const amenityResult = await pool.query(`
            SELECT a.location_id, at.amenity_name, a.available_count
            FROM amenities a
                     JOIN amenity_types at ON a.amenity_type_id = at.amenity_type_id
            WHERE a.available_count > 0
        `);

        const amenitiesByLocation = {};
        for (const row of amenityResult.rows) {
            if (!amenitiesByLocation[row.location_id]) amenitiesByLocation[row.location_id] = [];
            amenitiesByLocation[row.location_id].push(row.amenity_name.toLowerCase());
        }

        const userNoiseLevel = prefResult.rows.length > 0 ? parseFloat(prefResult.rows[0].noise_level) : null;
        const userCrowdLevel = prefResult.rows.length > 0 ? prefResult.rows[0].crowd_level : null; // 'low' | 'medium' | 'high'
        const hasPreferences = userNoiseLevel !== null || userCrowdLevel !== null || requiredAmenities.length > 0;

        if (!hasPreferences) {
            return res.status(400).json({
                error: 'No preferences found. Please set your preferences first.',
                hint: 'POST /api/user_preferences with noise_level and crowd_level'
            });
        }

        // Determine noise category from saved noise_level (1-10)
        let noiseCategory = null;
        if (userNoiseLevel !== null) {
            if (userNoiseLevel <= 3.5) noiseCategory = 'low';
            else if (userNoiseLevel <= 6) noiseCategory = 'medium';
            else noiseCategory = 'high';
        }

        const totalPreferences = (noiseCategory ? 1 : 0) + (userCrowdLevel ? 1 : 0) + requiredAmenities.length;

        // Score each location
        const scored = locationResult.rows.map(location => {
            const avgNoise        = location.avg_noise ? parseFloat(location.avg_noise) : null;
            const locationCrowd   = location.crowd_level ? location.crowd_level.toLowerCase() : null;
            const locationAmenities = amenitiesByLocation[location.location_id] || [];
            const preferenceResults = [];
            let matchCount = 0;

            // Check noise preference
            if (noiseCategory) {
                let noiseMet = false;
                if (avgNoise !== null) {
                    if (noiseCategory === 'low'    && avgNoise <= 3.5)                  noiseMet = true;
                    if (noiseCategory === 'medium' && avgNoise > 3.5 && avgNoise <= 6)  noiseMet = true;
                    if (noiseCategory === 'high'   && avgNoise >= 7)                    noiseMet = true;
                }
                preferenceResults.push({
                    preference: 'noise_level: ' + noiseCategory,
                    met: noiseMet,
                    detail: avgNoise !== null ? 'Avg noise: ' + avgNoise.toFixed(1) + '/10' : 'No noise data'
                });
                if (noiseMet) matchCount++;
            }

            // Check crowd level preference
            if (userCrowdLevel) {
                const crowdMet = locationCrowd !== null && locationCrowd === userCrowdLevel.toLowerCase();
                preferenceResults.push({
                    preference: 'crowd_level: ' + userCrowdLevel,
                    met: crowdMet,
                    detail: locationCrowd !== null ? 'Crowd level: ' + locationCrowd : 'No crowd data'
                });
                if (crowdMet) matchCount++;
            }

            // Check required amenities
            for (const amenity of requiredAmenities) {
                const met = locationAmenities.includes(amenity);
                preferenceResults.push({
                    preference: 'amenity: ' + amenity,
                    met,
                    detail: met ? amenity + ' is available' : amenity + ' is not available'
                });
                if (met) matchCount++;
            }

            return {
                locationId: location.location_id,
                locationName: location.name,
                address: location.address,
                matchScore: matchCount + '/' + totalPreferences,
                matchCount,
                totalPreferences,
                preferences: preferenceResults
            };
        });

        // Sort highest match first, filter zero matches
        scored.sort((a, b) => b.matchCount - a.matchCount);
        const results = scored.filter(loc => loc.matchCount > 0);

        if (results.length === 0) {
            return res.json({
                userId: user_id,
                results: [],
                message: 'No locations matched your saved preferences.'
            });
        }

        res.json({
            userId: user_id,
            resultCount: results.length,
            results
        });

    } catch (err) {
        console.error('Error generating recommendation:', err);
        res.status(500).json({ error: 'Failed to generate recommendation' });
    }
});


// ID corresponds to user_id, showing all recommendations for a user
app.get('/api/recommendations/:id', async (req, res) => {
    try {
        const {id} = req.params;
        const result = await pool.query(
            'SELECT * FROM recommendations WHERE user_id = $1',
            [id]
        );
        res.json(result.rows);
    }
    catch (err) {
        console.error('Error fetching recommendations: ', err);
        res.status(500).json({error: 'Failed to fetch recommendations'});
    }
});

app.post('/api/recommendations', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id;
        let {location_id, recommendation_score, location_noise, location_crowd} = req.body;

        location_noise = Number(location_noise).toFixed(0);

        if (!location_id || !recommendation_score || !location_noise || !location_crowd) {
            return res.status(400).json({error: 'Missing required fields'});
        }

        const location = await pool.query(
            'SELECT name FROM locations WHERE location_id = $1',
            [location_id]
        );
        if (location.rows.length === 0) {
            return res.status(404).json({error: 'Location not found'});
        }

        const result = await pool.query(`
            INSERT INTO recommendations (user_id, location_id, recommendation_score, was_accepted, noise_level, crowd_level, timestamp)
            VALUES ($1, $2, $3, true, $4, $5, NOW())
                RETURNING *
        `, [user_id, location_id, recommendation_score, location_noise, location_crowd]);

        res.status(201).json({
            message: 'Recommendation successfully posted',
            recommendation: result.rows[0]
        });
    }
    catch (err) {
        console.error('Error posting recommendation: ', err);
        res.status(500).json({error: 'Failed to post recommendation'});
    }
});

// LOCATION STATE ENDPOINTS

app.get('/api/location_states', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM location_states'
        );
        res.json(result.rows);
    }
    catch (err) {
        console.error('Error fetching location states: ', err);
        res.status(500).json({error: 'Failed to fetch location states'});
    }
});

app.get('/api/location_states/:id', async (req, res) => {
    try {
        const {id} = req.params;
        const result = await pool.query(
            'SELECT * FROM location_states WHERE location_id = $1',
            [id]
        );

        // Compute disclaimer for each time window row using historical timestamps
        const timestampsResult = await pool.query(
            'SELECT report_timestamp FROM user_reports WHERE location_id = $1 ORDER BY report_timestamp ASC',
            [id]
        );
        const timestamps = timestampsResult.rows.map(r => r.report_timestamp);
        const timeRelevancy = getTimeRelevancy(timestamps);

        const rows = result.rows.map(row => ({
            ...row,
            disclaimer: timeRelevancy.disclaimer,
            data_status: timeRelevancy.status,
            freshness_confidence: timeRelevancy.freshnessConfidence,
            avg_days_old: timeRelevancy.avgDaysOld ?? null
        }));

        res.json(rows);
    }
    catch (err) {
        console.error('Error fetching location state by id: ', err);
        res.status(500).json({error: 'Failed to fetch location state by id'});
    }
});

app.post('/api/location_states', async (req, res) => {
    try {
        const {location_id, time_window, avg_noise_level, avg_crowd_level, report_count, confidence_level} = req.body;

        if (!location_id || !time_window || !avg_noise_level || !avg_crowd_level || !report_count || !confidence_level) {
            return res.status(400).json({error: 'Missing required fields'});
        }

        const location = await pool.query(
            'SELECT name FROM locations WHERE location_id = $1',
            [location_id]
        );
        if (location.rows.length === 0) {
            return res.status(404).json({error: 'Location not found'});
        }

        const result = await pool.query(`
                    INSERT INTO location_states
                    (location_id, time_window, avg_noise_level, avg_crowd_level, report_count, confidence_level)
                    VALUES ($1, $2, $3, $4, $5, $6)
                        RETURNING *
            `,
            [location_id, time_window, avg_noise_level, avg_crowd_level, report_count, confidence_level]
        );
        res.status(201).json({
            message: 'Location state successfully posted',
            location_state: result.rows[0]
        });
    }
    catch (err) {
        console.error('Error posting location state: ', err);
        res.status(500).json({error: 'Failed to post location state'});
    }
});

// TIME RELEVANCY FEATURE

app.get('/api/locations/:id/data-sufficiency', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(`
            SELECT
                COUNT(*) as total_reports,
                COUNT(*) FILTER (WHERE report_timestamp > NOW() - INTERVAL '365 days') as recent_reports,
                MAX(report_timestamp) as most_recent_report,
                AVG(noise_level) FILTER (WHERE report_timestamp > NOW() - INTERVAL '365 days') as recent_avg_noise,
                STDDEV(noise_level) FILTER (WHERE report_timestamp > NOW() - INTERVAL '365 days') as noise_variance
            FROM user_reports
            WHERE location_id = $1
        `, [id]);

        const data = result.rows[0];
        const recentReports = parseInt(data.recent_reports) || 0;
        const totalReports = parseInt(data.total_reports) || 0;

        const MINIMUM_REPORTS = 10;
        const MAX_DAYS_OLD = 365;

        if (recentReports < MINIMUM_REPORTS) {
            return res.json({
                canClassify: false,
                reason: 'INSUFFICIENT_RECENT_DATA',
                message: `Need ${MINIMUM_REPORTS - recentReports} more recent reports`,
                details: { recentReports, totalReports, requiredReports: MINIMUM_REPORTS }
            });
        }

        const mostRecent = data.most_recent_report;
        const daysSinceLastReport = mostRecent
            ? (Date.now() - new Date(mostRecent)) / (1000 * 60 * 60 * 24)
            : 999;

        if (daysSinceLastReport > MAX_DAYS_OLD) {
            return res.json({
                canClassify: false,
                reason: 'STALE_DATA',
                message: `Last report was ${Math.floor(daysSinceLastReport)} days ago`,
                details: { lastReportDate: mostRecent, daysSinceLastReport: Math.floor(daysSinceLastReport) }
            });
        }

        const variance = parseFloat(data.noise_variance);
        if (variance > 2.5) {
            return res.json({
                canClassify: false,
                reason: 'INCONSISTENT_DATA',
                message: 'Reports show high variance - experiences vary too much',
                details: { variance: variance.toFixed(2), recentReports }
            });
        }

        res.json({
            canClassify: true,
            classification: getClassification(parseFloat(data.recent_avg_noise)),
            details: {
                recentReports,
                avgNoise: parseFloat(data.recent_avg_noise).toFixed(2),
                variance: variance.toFixed(2),
                lastUpdated: mostRecent,
                confidence: 'HIGH'
            }
        });

    } catch (err) {
        console.error('Error checking data sufficiency:', err);
        res.status(500).json({ error: 'Failed to check data sufficiency' });
    }
});

function getClassification(avgNoise) {
    if (avgNoise <= 3.5) return 'LOW';
    if (avgNoise <= 6)   return 'MEDIUM';
    return 'HIGH';
}


// USER REPORTS ENDPOINTS


// Submit a report — protected, uses user_id from JWT (not request body)
app.post('/api/reports', authenticateToken, async (req, res) => {
    try {
        const { location_id, noise_level, crowd_level, comments, amenities_available } = req.body;
        const user_id = req.user.user_id; // from JWT payload

        if (!location_id || !noise_level) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (noise_level < 1 || noise_level > 10) {
            return res.status(400).json({ error: 'Noise level must be between 1 and 10' });
        }

        const result = await pool.query(`
            INSERT INTO user_reports (user_id, location_id, noise_level, crowd_level, report_timestamp, comments, amenities_available)
            VALUES ($1, $2, $3, $4, NOW(), $5, $6)
                RETURNING *
        `, [user_id, location_id, noise_level, crowd_level || 'medium', comments || null, amenities_available || []]);

        res.status(201).json({
            message: 'Report submitted successfully',
            report: result.rows[0]
        });

        // Trigger live state update for this location in background
        processingVolatileAttributes(location_id).then(result => {
            console.log(`State updated for location ${location_id}:`, result.updated ? 'updated' : result.reason);
        }).catch(err => {
            console.error('State update failed:', err.message);
        });

    } catch (err) {
        console.error('Error submitting report:', err);
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

// Get recent reports for a location
app.get('/api/locations/:id/reports', async (req, res) => {
    try {
        const { id } = req.params;
        const daysFilter = Math.min(Math.max(parseInt(req.query.days) || 365, 1), 3650);

        const result = await pool.query(`
            SELECT
                report_id,
                noise_level,
                crowd_level,
                report_timestamp,
                confidence_score
            FROM user_reports
            WHERE location_id = $1
              AND report_timestamp > NOW() - ($2 || ' days')::INTERVAL
            ORDER BY report_timestamp DESC
        `, [id, daysFilter]);

        res.json({
            locationId: id,
            reportCount: result.rows.length,
            daysRange: daysFilter,
            reports: result.rows
        });

    } catch (err) {
        console.error('Error fetching reports:', err);
        res.status(500).json({ error: 'Failed to fetch reports' });
    }
});

// CHECK-IN / CHECK-OUT ENDPOINTS (JWT protected)

// Check in to a location
app.post('/api/checkin', authenticateToken, async (req, res) => {
    try {
        const { location_id } = req.body;
        const user_id = req.user.user_id; // from JWT

        if (!location_id) {
            return res.status(400).json({ error: 'location_id is required' });
        }

        // Verify location exists
        const location = await pool.query(
            'SELECT location_id, name FROM locations WHERE location_id = $1',
            [location_id]
        );
        if (location.rows.length === 0) {
            return res.status(404).json({ error: 'Location not found' });
        }

        // Prevent double check-in — ensure no open session exists
        const openSession = await pool.query(`
            SELECT check_in_id FROM check_ins
            WHERE user_id = $1 AND check_out_time IS NULL
        `, [user_id]);

        if (openSession.rows.length > 0) {
            return res.status(409).json({ error: 'Already checked in. Check out first.' });
        }

        const result = await pool.query(`
            INSERT INTO check_ins (user_id, location_id, check_in_time)
            VALUES ($1, $2, NOW())
                RETURNING check_in_id, location_id, check_in_time
        `, [user_id, location_id]);

        res.status(201).json({
            message: 'Checked in successfully',
            checkIn: {
                ...result.rows[0],
                locationName: location.rows[0].name
            }
        });

    } catch (err) {
        console.error('Error checking in:', err);
        res.status(500).json({ error: 'Failed to check in' });
    }
});

// Check out of a location
app.post('/api/checkout', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id; // from JWT

        // Find the open check-in session
        const openSession = await pool.query(`
            SELECT check_in_id, check_in_time, location_id
            FROM check_ins
            WHERE user_id = $1 AND check_out_time IS NULL
        `, [user_id]);

        if (openSession.rows.length === 0) {
            return res.status(400).json({ error: 'No active check-in found' });
        }

        const session = openSession.rows[0];

        const result = await pool.query(`
            UPDATE check_ins
            SET check_out_time = NOW()
            WHERE check_in_id = $1
                RETURNING check_in_id, location_id, check_in_time, check_out_time
        `, [session.check_in_id]);

        const { check_in_time, check_out_time } = result.rows[0];
        const durationMinutes = Math.round(
            (new Date(check_out_time) - new Date(check_in_time)) / (1000 * 60)
        );

        // Check if there's an accepted recommendation for optional followup (CB4)
        const most_recent_rec = await pool.query(`
            SELECT recommendation_id
            FROM recommendations
            WHERE user_id = $1 AND was_accepted
            ORDER BY timestamp DESC
                LIMIT 1
        `, [user_id]);

        const followup = most_recent_rec.rows.length > 0
            ? { available: true, recommendation_id: most_recent_rec.rows[0].recommendation_id }
            : { available: false };

        res.json({
            message: 'Checked out successfully',
            checkOut: {
                ...result.rows[0],
                durationMinutes
            },
            followup  // Available: true means frontend can prompt for feedback
        });
        return;

    } catch (err) {
        console.error('Error checking out:', err);
        res.status(500).json({ error: 'Failed to check out' });
    }
});

app.post('/api/followup', async (req, res) => {

    let {recommendation_id, curr_noise_level, curr_crowd_level} = req.body;

    if (!recommendation_id || !curr_noise_level || !curr_crowd_level) {
        return res.status(400).json({error: 'Missing required fields'});
    }

    let recommendation = await pool.query(`
        SELECT noise_level, crowd_level, location_id, user_id
        FROM recommendations
        WHERE recommendation_id = $1
    `, [recommendation_id]);

    if (recommendation.rows.length === 0) {
        return res.status(404).json({error: 'No such recommendation with id ' + recommendation_id})
    }

    let {user_id, location_id, noise_level:rec_noise_level, crowd_level:rec_crowd_level} = recommendation.rows[0];

    await pool.query(`
        INSERT INTO user_reports (user_id, location_id, noise_level, crowd_level, report_timestamp)
        VALUES ($1, $2, $3, $4, NOW())
    `, [user_id, location_id, curr_noise_level, curr_crowd_level])

    switch (rec_crowd_level) {
        case "low":
            rec_crowd_level = 1;
            break;
        case "medium":
            rec_crowd_level = 2;
            break;
        case "high":
            rec_crowd_level = 3;
    }

    switch (curr_crowd_level) {
        case "low":
            curr_crowd_level = 1;
            break;
        case "medium":
            curr_crowd_level = 2;
            break;
        case "high":
            curr_crowd_level = 3;
    }

    // Get current volatility index of the location
    const location = await pool.query(`
        SELECT volatility_index
        FROM locations
        WHERE location_id = $1;
    `, [location_id]);

    let curr_vol = Number(location.rows[0].volatility_index);

    // Begin data analysis
    const BASE_THRESHOLD = .75;
    const EXPECTED_THRESHOLD = curr_vol * BASE_THRESHOLD;
    const WEIGHT_ADJUST = 2
    const NOISE_RANGE = 9 * WEIGHT_ADJUST;
    const CROWD_RANGE = 2 * WEIGHT_ADJUST;

    let noise_diff = Math.abs(rec_noise_level - curr_noise_level);

    let crowd_diff = Math.abs(rec_crowd_level - curr_crowd_level);

    let calc_vol = 0;

    calc_vol += noise_diff / NOISE_RANGE;

    calc_vol += crowd_diff / CROWD_RANGE;

    if (noise_diff > NOISE_RANGE * EXPECTED_THRESHOLD && crowd_diff > CROWD_RANGE * EXPECTED_THRESHOLD) {
        calc_vol *= 1.25
    }

    calc_vol = Math.min(1, calc_vol);

    const VOL_DIFF_THRESHOLD = .25
    let vol_diff_cond = Math.abs(calc_vol - curr_vol) > VOL_DIFF_THRESHOLD;
    let result;
    if (vol_diff_cond) {
        result = await pool.query(`
            UPDATE locations
            SET volatility_index = $1
            WHERE location_id = $2
            RETURNING *;
        `, [(calc_vol + curr_vol) / 2, location_id])
    }
    let message;
    if (!result || result.rows.length !== 1) message = "Locations table not altered";
    else message = result.rows[0];
    res.json({
        message: "Successfully processed followup",
        result: {
            message
        }
    });
});

// Get check-in status for the logged-in user
app.get('/api/checkin/status', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id;

        const result = await pool.query(`
            SELECT
                c.check_in_id,
                c.location_id,
                l.name as location_name,
                c.check_in_time
            FROM check_ins c
                     JOIN locations l ON c.location_id = l.location_id
            WHERE c.user_id = $1 AND c.check_out_time IS NULL
        `, [user_id]);

        if (result.rows.length === 0) {
            return res.json({ checkedIn: false });
        }

        res.json({
            checkedIn: true,
            session: result.rows[0]
        });

    } catch (err) {
        console.error('Error fetching check-in status:', err);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

// Get check-in history for the logged-in user
app.get('/api/checkin/history', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id;

        const result = await pool.query(`
            SELECT
                c.check_in_id,
                l.name as location_name,
                c.check_in_time,
                c.check_out_time,
                ROUND(
                        EXTRACT(EPOCH FROM (c.check_out_time - c.check_in_time)) / 60
                ) as duration_minutes
            FROM check_ins c
                     JOIN locations l ON c.location_id = l.location_id
            WHERE c.user_id = $1
            ORDER BY c.check_in_time DESC
                LIMIT 50
        `, [user_id]);

        res.json({
            userId: user_id,
            history: result.rows
        });

    } catch (err) {
        console.error('Error fetching check-in history:', err);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});


// CB2: PREFERENCE MATCHING ENDPOINT


// POST /api/locations/search
// Ranks locations by how many user preferences they satisfy.
// Returns match score and labels each preference MET or NOT MET.
// Body: { "noise_preference": "low"|"medium"|"high"|"any", "amenities": ["Wifi","Outlets"] }
app.post('/api/locations/search', async (req, res) => {
    try {
        const { noise_preference, amenities = [] } = req.body;

        const validNoiseOptions = ['low', 'medium', 'high', 'any'];
        if (!noise_preference || !validNoiseOptions.includes(noise_preference)) {
            return res.status(400).json({
                error: 'noise_preference is required: low, medium, high, or any'
            });
        }

        const hasAmenities = Array.isArray(amenities) && amenities.length > 0;
        if (noise_preference === 'any' && !hasAmenities) {
            return res.status(400).json({
                error: 'Provide at least one preference — noise_preference or amenities'
            });
        }

        // Get all locations with avg noise from recent reports
        const locationResult = await pool.query(`
            SELECT
                l.location_id,
                l.name,
                l.address,
                AVG(ur.noise_level) FILTER (WHERE ur.report_timestamp > NOW() - INTERVAL '365 days') as avg_noise
            FROM locations l
                     LEFT JOIN user_reports ur ON l.location_id = ur.location_id
            GROUP BY l.location_id, l.name, l.address
            ORDER BY l.location_id
        `);

        const locations = locationResult.rows;
        if (locations.length === 0) return res.json({ results: [], message: 'No locations found' });

        const amenityResult = await pool.query(`
            SELECT a.location_id, at.amenity_name, a.available_count
            FROM amenities a
                     JOIN amenity_types at ON a.amenity_type_id = at.amenity_type_id
            WHERE a.available_count > 0
        `);

        const amenitiesByLocation = {};
        for (const row of amenityResult.rows) {
            if (!amenitiesByLocation[row.location_id]) amenitiesByLocation[row.location_id] = [];
            amenitiesByLocation[row.location_id].push(row.amenity_name.toLowerCase());
        }

        const totalPreferences = (noise_preference !== 'any' ? 1 : 0) + amenities.length;

        // Score each location against every preference
        const scored = locations.map(location => {
            const avgNoise = location.avg_noise ? parseFloat(location.avg_noise) : null;
            const locationAmenities = amenitiesByLocation[location.location_id] || [];
            const preferenceResults = [];
            let matchCount = 0;

            if (noise_preference !== 'any') {
                let noiseMet = false;
                if (avgNoise !== null) {
                    if (noise_preference === 'low'    && avgNoise <= 3.5)                 noiseMet = true;
                    if (noise_preference === 'medium' && avgNoise > 3.5 && avgNoise <= 6) noiseMet = true;
                    if (noise_preference === 'high'   && avgNoise > 6)                    noiseMet = true;
                }
                preferenceResults.push({
                    preference: 'noise_level: ' + noise_preference + ' (low<=3.5, medium=3.6-6, high>=7)',
                    met: noiseMet,
                    detail: avgNoise !== null
                        ? `Avg noise: ${avgNoise.toFixed(1)}/10 (${noiseLevel(avgNoise)}) — looking for ${noise_preference}`
                        : 'No noise data available'
                });
                if (noiseMet) matchCount++;
            }

            // Check each amenity preference
            for (const amenity of amenities) {
                const met = locationAmenities.includes(amenity.toLowerCase());
                preferenceResults.push({
                    preference: 'amenity: ' + amenity,
                    met,
                    detail: met ? amenity + ' is available' : amenity + ' is not available'
                });
                if (met) matchCount++;
            }

            return {
                locationId: location.location_id,
                locationName: location.name,
                address: location.address,
                matchScore: matchCount + '/' + totalPreferences,
                matchCount,
                totalPreferences,
                preferences: preferenceResults
            };
        });

        // Sort highest match first, filter out zero matches
        scored.sort((a, b) => b.matchCount - a.matchCount);
        const results = scored.filter(loc => loc.matchCount > 0);

        if (results.length === 0) {
            return res.json({
                query: { noise_preference, amenities },
                totalPreferences,
                results: [],
                message: 'No locations matched any of your preferences.'
            });
        }

        res.json({
            query: { noise_preference, amenities },
            totalPreferences,
            resultCount: results.length,
            results
        });

    } catch (err) {
        console.error('Error searching locations:', err);
        res.status(500).json({ error: 'Failed to search locations' });
    }
});


// ERROR HANDLING

app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// START SERVER

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Auth:     POST /api/register | POST /api/login | POST /api/token | DELETE /api/logout`);
    console.log(`Check-in: POST /api/checkin  | POST /api/checkout | GET /api/checkin/status | GET /api/checkin/history`);
    console.log(`Reports:  POST /api/reports (protected) | GET /api/locations/:id/reports`);
});
