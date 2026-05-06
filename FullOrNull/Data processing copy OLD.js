require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
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


// JWT CONFIG
// Add to your .env:
//   ACCESS_TOKEN_SECRET=...
//   REFRESH_TOKEN_SECRET=...

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;

let refreshTokens = []; // swap for DB table in production


// JWT MIDDLEWARE

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

    if (!token) return res.status(401).json({ error: 'Access token required' });

    jwt.verify(token, ACCESS_TOKEN_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
}


// HELPER FUNCTIONS

// Thresholds match Data_processing.js: LOW<=3.5, MEDIUM<=6, HIGH>=7
function getClassification(avgNoise) {
    if (avgNoise <= 3.5) return 'LOW';
    if (avgNoise <= 6)   return 'MEDIUM';
    return 'HIGH';
}

function getConfidenceLevel(daysSinceLastReport, variance, recentReports) {
    if (daysSinceLastReport > 60) return 'LOW';
    if (daysSinceLastReport > 30) return 'MEDIUM';
    if (variance > 1.5 || recentReports < 15) return 'MEDIUM';
    return 'HIGH';
}

function getSummary(classification) {
    if (classification === 'LOW')  return 'This location is typically quiet — good for focused study.';
    if (classification === 'HIGH') return 'This location tends to be loud — good for collaborative work.';
    return 'This location has mixed noise levels — conditions vary.';
}


// BASIC ENDPOINTS


app.get('/api/health', (req, res) => {
    res.json({ status: 'Server is running', timestamp: new Date() });
});

app.get('/api/test', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ message: 'Backend connected to database!', time: result.rows[0].now });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// AUTH ENDPOINTS


// Register — hash password with bcrypt, insert into users
app.post('/api/register', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password)
            return res.status(400).json({ error: 'Email and password are required' });
        if (password.length < 8)
            return res.status(400).json({ error: 'Password must be at least 8 characters' });

        const existing = await pool.query('SELECT user_id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0)
            return res.status(409).json({ error: 'Email already registered' });

        const password_hash = await bcrypt.hash(password, 12);

        const result = await pool.query(
            `INSERT INTO users (email, password_hash, created_at)
             VALUES ($1, $2, NOW())
             RETURNING user_id, email, created_at`,
            [email, password_hash]
        );

        res.status(201).json({ message: 'Registered successfully', user: result.rows[0] });

    } catch (err) {
        console.error('Error registering user:', err);
        res.status(500).json({ error: 'Failed to register user' });
    }
});

// Login — verify bcrypt hash, issue access + refresh tokens
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password)
            return res.status(400).json({ error: 'Email and password are required' });

        const result = await pool.query(
            'SELECT user_id, email, password_hash FROM users WHERE email = $1',
            [email]
        );
        if (result.rows.length === 0)
            return res.status(401).json({ error: 'Invalid credentials' });

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword)
            return res.status(401).json({ error: 'Invalid credentials' });

        await pool.query('UPDATE users SET last_login = NOW() WHERE user_id = $1', [user.user_id]);

        const payload = { user_id: user.user_id, email: user.email };
        const accessToken  = jwt.sign(payload, ACCESS_TOKEN_SECRET,  { expiresIn: '15m' });
        const refreshToken = jwt.sign(payload, REFRESH_TOKEN_SECRET, { expiresIn: '7d' });
        refreshTokens.push(refreshToken);

        res.json({ accessToken, refreshToken });

    } catch (err) {
        console.error('Error logging in:', err);
        res.status(500).json({ error: 'Failed to login' });
    }
});

// Refresh — issue new access token from valid refresh token
app.post('/api/token', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(401).json({ error: 'Refresh token required' });
    if (!refreshTokens.includes(token)) return res.status(403).json({ error: 'Invalid refresh token' });

    jwt.verify(token, REFRESH_TOKEN_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired refresh token' });
        const accessToken = jwt.sign(
            { user_id: user.user_id, email: user.email },
            ACCESS_TOKEN_SECRET,
            { expiresIn: '15m' }
        );
        res.json({ accessToken });
    });
});

// Logout — invalidate refresh token
app.delete('/api/logout', (req, res) => {
    const { token } = req.body;
    refreshTokens = refreshTokens.filter(t => t !== token);
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
        const result = await pool.query('SELECT * FROM locations WHERE location_id = $1', [id]);
        if (result.rows.length === 0)
            return res.status(404).json({ error: 'Location not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching location:', err);
        res.status(500).json({ error: 'Failed to fetch location' });
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
        const totalReports  = parseInt(data.total_reports)  || 0;
        const MINIMUM_REPORTS = 10;
        const MAX_DAYS_OLD    = 365;

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


// RECOMMENDATION ENDPOINT (CC-1)


// GET /api/locations/:id/recommendation
// Returns recommendation with confidence level + stale data disclaimer
app.get('/api/locations/:id/recommendation', async (req, res) => {
    try {
        const { id } = req.params;

        const location = await pool.query(
            'SELECT location_id, name, address FROM locations WHERE location_id = $1', [id]
        );
        if (location.rows.length === 0)
            return res.status(404).json({ error: 'Location not found' });

        const result = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE report_timestamp > NOW() - INTERVAL '365 days') as recent_reports,
                COUNT(*) FILTER (WHERE report_timestamp > NOW() - INTERVAL '30 days')  as last_30_days,
                COUNT(*) FILTER (WHERE report_timestamp > NOW() - INTERVAL '7 days')   as last_7_days,
                MAX(report_timestamp) as most_recent_report,
                AVG(noise_level) FILTER (WHERE report_timestamp > NOW() - INTERVAL '365 days') as avg_noise,
                STDDEV(noise_level) FILTER (WHERE report_timestamp > NOW() - INTERVAL '365 days') as noise_variance,
                AVG(noise_level) FILTER (WHERE report_timestamp > NOW() - INTERVAL '30 days') as recent_avg_noise
            FROM user_reports
            WHERE location_id = $1
        `, [id]);

        const data = result.rows[0];
        const recentReports = parseInt(data.recent_reports) || 0;
        const last30 = parseInt(data.last_30_days) || 0;
        const last7  = parseInt(data.last_7_days)  || 0;
        const MINIMUM_REPORTS = 10;

        // Not enough data — cannot recommend
        if (recentReports < MINIMUM_REPORTS) {
            return res.json({
                locationId: parseInt(id),
                locationName: location.rows[0].name,
                canRecommend: false,
                reason: 'INSUFFICIENT_DATA',
                message: `Not enough data to make a recommendation. Need ${MINIMUM_REPORTS - recentReports} more reports.`,
                details: { recentReports, requiredReports: MINIMUM_REPORTS }
            });
        }

        const mostRecent = data.most_recent_report;
        const daysSinceLastReport = mostRecent
            ? (Date.now() - new Date(mostRecent)) / (1000 * 60 * 60 * 24)
            : 999;

        const avgNoise       = parseFloat(data.avg_noise);
        const recentAvgNoise = data.recent_avg_noise ? parseFloat(data.recent_avg_noise) : avgNoise;
        const variance       = parseFloat(data.noise_variance) || 0;
        const classification = getClassification(recentAvgNoise);
        const confidence     = getConfidenceLevel(daysSinceLastReport, variance, recentReports);

        // Build stale disclaimer if needed
        let disclaimer = null;
        if (daysSinceLastReport > 60) {
            disclaimer = `Data is ${Math.floor(daysSinceLastReport)} days old — conditions may have changed. Low confidence.`;
        } else if (daysSinceLastReport > 30) {
            disclaimer = `Last report was ${Math.floor(daysSinceLastReport)} days ago. Consider this a general estimate.`;
        }

        res.json({
            locationId: parseInt(id),
            locationName: location.rows[0].name,
            canRecommend: true,
            recommendation: {
                classification,       // LOW | MEDIUM | HIGH
                confidence,           // HIGH | MEDIUM | LOW
                avgNoiseLevel: recentAvgNoise.toFixed(2),
                summary: getSummary(classification)
            },
            dataHealth: {
                totalReports: recentReports,
                last7Days: last7,
                last30Days: last30,
                daysSinceLastReport: Math.floor(daysSinceLastReport),
                lastReportDate: mostRecent,
                isStale: daysSinceLastReport > 30
            },
            disclaimer   // null = fresh data, string = stale warning
        });

    } catch (err) {
        console.error('Error generating recommendation:', err);
        res.status(500).json({ error: 'Failed to generate recommendation' });
    }
});


// LOCATION STATE ENDPOINT (CC-3)


// GET /api/locations/:id/state
// Checks reports across time windows and only updates state if sufficient
// data exists — prevents state from flipping on a single report
app.get('/api/locations/:id/state', async (req, res) => {
    try {
        const { id } = req.params;

        const location = await pool.query(
            'SELECT location_id, name FROM locations WHERE location_id = $1', [id]
        );
        if (location.rows.length === 0)
            return res.status(404).json({ error: 'Location not found' });

        // Get current stored state
        const currentState = await pool.query(`
            SELECT * FROM location_states
            WHERE location_id = $1
            ORDER BY last_updated DESC LIMIT 1
        `, [id]);

        // Analyze reports across multiple time windows to detect trends
        const w = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE report_timestamp > NOW() - INTERVAL '7 days')  as reports_7d,
                COUNT(*) FILTER (WHERE report_timestamp > NOW() - INTERVAL '30 days') as reports_30d,
                COUNT(*) FILTER (WHERE report_timestamp > NOW() - INTERVAL '90 days') as reports_90d,
                AVG(noise_level) FILTER (WHERE report_timestamp > NOW() - INTERVAL '7 days')  as avg_noise_7d,
                AVG(noise_level) FILTER (WHERE report_timestamp > NOW() - INTERVAL '30 days') as avg_noise_30d,
                AVG(noise_level) FILTER (WHERE report_timestamp > NOW() - INTERVAL '90 days') as avg_noise_90d
            FROM user_reports WHERE location_id = $1
        `, [id]);

        const win = w.rows[0];
        const reports7d  = parseInt(win.reports_7d)  || 0;
        const reports30d = parseInt(win.reports_30d) || 0;
        const reports90d = parseInt(win.reports_90d) || 0;

        const MINIMUM_REPORTS_TO_UPDATE = 5;
        const TIME_WINDOW = '30 days';

        // Not enough data in window — state stays unchanged
        if (reports30d < MINIMUM_REPORTS_TO_UPDATE) {
            return res.json({
                locationId: parseInt(id),
                locationName: location.rows[0].name,
                stateUpdated: false,
                reason: 'INSUFFICIENT_DATA_IN_WINDOW',
                message: `Only ${reports30d} reports in the last ${TIME_WINDOW}. Need at least ${MINIMUM_REPORTS_TO_UPDATE} to update state.`,
                currentState: currentState.rows.length > 0 ? {
                    classification: getClassification(parseFloat(currentState.rows[0].avg_noise_level)),
                    lastUpdated: currentState.rows[0].last_updated,
                    confidenceScore: currentState.rows[0].confidence_level
                } : null,
                dataWindow: {
                    last7Days: reports7d,
                    last30Days: reports30d,
                    last90Days: reports90d,
                    requiredReports: MINIMUM_REPORTS_TO_UPDATE,
                    timeWindow: TIME_WINDOW
                }
            });
        }

        // Enough data — compute new state
        const newAvgNoise      = parseFloat(win.avg_noise_30d);
        const newClassification = getClassification(newAvgNoise);

        // Detect trend: compare 7-day average vs 30-day average
        let trend = 'STABLE';
        if (win.avg_noise_7d && win.avg_noise_30d) {
            const diff = parseFloat(win.avg_noise_7d) - parseFloat(win.avg_noise_30d);
            if (diff > 1.0) trend = 'GETTING_LOUDER';
            if (diff < -1.0) trend = 'GETTING_QUIETER';
        }

        // Confidence score based on report volume across windows
        let confidenceScore = 0.5;
        if (reports7d  >= 5)  confidenceScore += 0.2;
        if (reports30d >= 10) confidenceScore += 0.2;
        if (reports90d >= 20) confidenceScore += 0.1;

        // Persist new state to location_states table
        await pool.query(`
            INSERT INTO location_states
            (location_id, time_window, avg_noise_level, avg_crowd_level, report_count, last_updated, confidence_level)
            VALUES ($1, $2, $3, $4, $5, NOW(), $6)
        `, [id, TIME_WINDOW, newAvgNoise.toFixed(2), 'medium', reports30d, confidenceScore.toFixed(2)]);

        res.json({
            locationId: parseInt(id),
            locationName: location.rows[0].name,
            stateUpdated: true,
            currentState: {
                classification: newClassification,   // LOW | MEDIUM | HIGH
                avgNoiseLevel: newAvgNoise.toFixed(2),
                trend,                               // STABLE | GETTING_LOUDER | GETTING_QUIETER
                confidenceScore: confidenceScore.toFixed(2),
                lastUpdated: new Date()
            },
            dataWindow: {
                last7Days: reports7d,
                last30Days: reports30d,
                last90Days: reports90d,
                timeWindow: TIME_WINDOW
            },
            algorithm: {
                minimumReportsRequired: MINIMUM_REPORTS_TO_UPDATE,
                primaryWindow: TIME_WINDOW,
                note: 'State only updates when sufficient reports exist in the time window — prevents flipping on single reports'
            }
        });

    } catch (err) {
        console.error('Error fetching location state:', err);
        res.status(500).json({ error: 'Failed to fetch location state' });
    }
});




// PREFERENCE MATCHING ENDPOINT (CC-2)


// POST /api/locations/search
// Ranks locations by how many user preferences they satisfy.
// Returns match score and labels each preference MET or NOT MET.
//
// Body: { "noise_preference": "quiet"|"loud"|"any", "amenities": ["wifi","outlets"] }
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

        // Get all available amenities grouped by location
        // available_count > 0 matches Coral's schema (no is_available boolean column)
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

        // Score each location
        const scored = locations.map(location => {
            const avgNoise = location.avg_noise ? parseFloat(location.avg_noise) : null;
            const locationAmenities = amenitiesByLocation[location.location_id] || [];
            const preferenceResults = [];
            let matchCount = 0;

            // Check noise preference
            if (noise_preference !== 'any') {
                let noiseMet = false;
                // Thresholds match Data_processing.js: low<=3.5, medium>3.5&&<=6, high>=7
                if (avgNoise !== null) {
                    if (noise_preference === 'low'    && avgNoise <= 3.5)                    noiseMet = true;
                    if (noise_preference === 'medium' && avgNoise > 3.5 && avgNoise <= 6)    noiseMet = true;
                    if (noise_preference === 'high'   && avgNoise >= 7)                      noiseMet = true;
                }
                preferenceResults.push({
                    preference: 'noise_level: ' + noise_preference + ' (low<=3.5, medium=3.6-6, high>=7)',
                    met: noiseMet,
                    detail: avgNoise !== null
                        ? 'Average noise level is ' + avgNoise.toFixed(1) + '/10'
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

// USER REPORTS ENDPOINTS


// Submit a report — protected, uses user_id from JWT
app.post('/api/reports', authenticateToken, async (req, res) => {
    try {
        const { location_id, noise_level, crowd_level } = req.body;
        const user_id = req.user.user_id;

        if (!location_id || !noise_level)
            return res.status(400).json({ error: 'Missing required fields' });
        if (noise_level < 1 || noise_level > 10)
            return res.status(400).json({ error: 'Noise level must be between 1 and 10' });

        const result = await pool.query(`
            INSERT INTO user_reports (user_id, location_id, noise_level, crowd_level, report_timestamp)
            VALUES ($1, $2, $3, $4, NOW())
            RETURNING *
        `, [user_id, location_id, noise_level, crowd_level || 'medium']);

        res.status(201).json({ message: 'Report submitted successfully', report: result.rows[0] });

    } catch (err) {
        console.error('Error submitting report:', err);
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

// Get recent reports for a location (SQL injection fix on INTERVAL)
app.get('/api/locations/:id/reports', async (req, res) => {
    try {
        const { id } = req.params;
        const daysFilter = Math.min(Math.max(parseInt(req.query.days) || 365, 1), 3650);

        const result = await pool.query(`
            SELECT report_id, noise_level, crowd_level, report_timestamp, confidence_score
            FROM user_reports
            WHERE location_id = $1
              AND report_timestamp > NOW() - ($2 || ' days')::INTERVAL
            ORDER BY report_timestamp DESC
        `, [id, daysFilter]);

        res.json({ locationId: id, reportCount: result.rows.length, daysRange: daysFilter, reports: result.rows });

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
        const user_id = req.user.user_id;

        if (!location_id)
            return res.status(400).json({ error: 'location_id is required' });

        const location = await pool.query(
            'SELECT location_id, name FROM locations WHERE location_id = $1', [location_id]
        );
        if (location.rows.length === 0)
            return res.status(404).json({ error: 'Location not found' });

        const openSession = await pool.query(
            'SELECT check_in_id FROM check_ins WHERE user_id = $1 AND check_out_time IS NULL',
            [user_id]
        );
        if (openSession.rows.length > 0)
            return res.status(409).json({ error: 'Already checked in. Check out first.' });

        const result = await pool.query(`
            INSERT INTO check_ins (user_id, location_id, check_in_time)
            VALUES ($1, $2, NOW())
            RETURNING check_in_id, location_id, check_in_time
        `, [user_id, location_id]);

        res.status(201).json({
            message: 'Checked in successfully',
            checkIn: { ...result.rows[0], locationName: location.rows[0].name }
        });

    } catch (err) {
        console.error('Error checking in:', err);
        res.status(500).json({ error: 'Failed to check in' });
    }
});

// Check out of a location
app.post('/api/checkout', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id;

        const openSession = await pool.query(
            'SELECT check_in_id, check_in_time FROM check_ins WHERE user_id = $1 AND check_out_time IS NULL',
            [user_id]
        );
        if (openSession.rows.length === 0)
            return res.status(400).json({ error: 'No active check-in found' });

        const result = await pool.query(`
            UPDATE check_ins SET check_out_time = NOW()
            WHERE check_in_id = $1
            RETURNING check_in_id, location_id, check_in_time, check_out_time
        `, [openSession.rows[0].check_in_id]);

        const { check_in_time, check_out_time } = result.rows[0];
        const durationMinutes = Math.round(
            (new Date(check_out_time) - new Date(check_in_time)) / (1000 * 60)
        );

        res.json({
            message: 'Checked out successfully',
            checkOut: { ...result.rows[0], durationMinutes }
        });

    } catch (err) {
        console.error('Error checking out:', err);
        res.status(500).json({ error: 'Failed to check out' });
    }
});

// Current check-in status
app.get('/api/checkin/status', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id;

        const result = await pool.query(`
            SELECT c.check_in_id, c.location_id, l.name as location_name, c.check_in_time
            FROM check_ins c
                     JOIN locations l ON c.location_id = l.location_id
            WHERE c.user_id = $1 AND c.check_out_time IS NULL
        `, [user_id]);

        if (result.rows.length === 0) return res.json({ checkedIn: false });
        res.json({ checkedIn: true, session: result.rows[0] });

    } catch (err) {
        console.error('Error fetching check-in status:', err);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

// Check-in history
app.get('/api/checkin/history', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id;

        const result = await pool.query(`
            SELECT
                c.check_in_id,
                l.name as location_name,
                c.check_in_time,
                c.check_out_time,
                ROUND(EXTRACT(EPOCH FROM (c.check_out_time - c.check_in_time)) / 60) as duration_minutes
            FROM check_ins c
                     JOIN locations l ON c.location_id = l.location_id
            WHERE c.user_id = $1
            ORDER BY c.check_in_time DESC
            LIMIT 50
        `, [user_id]);

        res.json({ userId: user_id, history: result.rows });

    } catch (err) {
        console.error('Error fetching check-in history:', err);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});


// CC-4: POST-CHECKOUT FEEDBACK ENDPOINT


// Submit accuracy feedback after checkout
app.post('/api/checkins/:checkinId/feedback', authenticateToken, async (req, res) => {
    try {
        const { checkinId } = req.params;
        const { noiseAccurate, noiseCorrected, crowdAccurate, crowdCorrected } = req.body;

        if (typeof noiseAccurate !== 'boolean' || typeof crowdAccurate !== 'boolean')
            return res.status(400).json({ error: 'noiseAccurate and crowdAccurate must be booleans.' });

        if (!noiseAccurate && (noiseCorrected == null || noiseCorrected < 1 || noiseCorrected > 10))
            return res.status(400).json({ error: 'noiseCorrected must be between 1 and 10 when noise is inaccurate.' });

        if (!crowdAccurate && (crowdCorrected == null || crowdCorrected < 1 || crowdCorrected > 10))
            return res.status(400).json({ error: 'crowdCorrected must be between 1 and 10 when crowd is inaccurate.' });

        const checkinResult = await pool.query(
            'SELECT * FROM check_ins WHERE check_in_id = $1 AND user_id = $2',
            [checkinId, req.user.user_id]
        );
        if (checkinResult.rows.length === 0)
            return res.status(404).json({ error: 'Check-in not found.' });

        if (checkinResult.rows[0].feedback_submitted)
            return res.status(409).json({ error: 'Feedback already submitted for this check-in.' });

        await pool.query(`
            UPDATE check_ins
            SET noise_accurate     = $1,
                noise_corrected    = $2,
                crowd_accurate     = $3,
                crowd_corrected    = $4,
                feedback_submitted = TRUE
            WHERE check_in_id = $5
        `, [
            noiseAccurate,
            noiseAccurate ? null : noiseCorrected,
            crowdAccurate,
            crowdAccurate ? null : crowdCorrected,
            checkinId
        ]);

        res.status(200).json({
            message: 'Feedback submitted successfully.',
            feedback: {
                noise: { accurate: noiseAccurate, correctedValue: noiseAccurate ? null : noiseCorrected, correctedLabel: noiseAccurate ? null : getClassification(noiseCorrected) },
                crowd: { accurate: crowdAccurate, correctedValue: crowdAccurate ? null : crowdCorrected, correctedLabel: crowdAccurate ? null : getClassification(crowdCorrected) }
            }
        });

    } catch (err) {
        console.error('Error submitting feedback:', err);
        res.status(500).json({ error: 'Failed to submit feedback' });
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
    console.log(`Auth:           POST /api/register | POST /api/login | POST /api/token | DELETE /api/logout`);
    console.log(`Locations:      GET  /api/locations | GET /api/locations/:id`);
    console.log(`Recommendation: GET  /api/locations/:id/recommendation  (CC-1)`);
    console.log(`Location State: GET  /api/locations/:id/state           (CC-3)`);
    console.log(`Check-in:       POST /api/checkin | POST /api/checkout | GET /api/checkin/status | GET /api/checkin/history`);
    console.log(`Reports:        POST /api/reports | GET /api/locations/:id/reports`);
    console.log(`Feedback (CC-4): POST /api/checkins/:checkinId/feedback`);
});