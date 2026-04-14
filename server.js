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


// JWT CONFIG

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;

// In-memory refresh token store — swap for a DB table in production
let refreshTokens = [];

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

        // Hash password with bcrypt (12 salt rounds)
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

        // Compare plaintext password against stored bcrypt hash
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

        // Short-lived access token (15 min)
        const accessToken = jwt.sign(payload, ACCESS_TOKEN_SECRET, { expiresIn: '15m' });

        // Long-lived refresh token (7 days)
        const refreshToken = jwt.sign(payload, REFRESH_TOKEN_SECRET, { expiresIn: '7d' });
        refreshTokens.push(refreshToken);

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

app.post('/api/user_preferences', async (req, res) => {
    try {
        const {user_id, noise_level, crowd_level} = req.body;

        if (!user_id || !noise_level || !crowd_level) {
            return res.status(400).json({error: 'Missing required fields'});
        }

        const user = await pool.query(
            'SELECT user_id FROM users WHERE user_id = $1',
            [user_id]
        );
        if (user.rows.length === 0) {
            return res.status(404).json({error: 'User not found'});
        }

        if (noise_level < 1 || noise_level > 10) {
            return res.status(400).json({error: 'Noise level must be between 1 and 10'});
        }

        // CONFIRM ABOUT ALLOW DUPLICATES
        // const user_preference = await pool.query(`
        //     SELECT user_id FROM user_preferences
        //         WHERE user_id = $1 AND amenity_type_id = $2
        //     `,
        //     [location_id, amenity_type_id]
        // );
        // if (location_amenity.rows.length !== 0) {
        //     return res.status(409).json({error: 'Amenity type already defined for location'});
        // }

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

// ID corresponds to user_preferred_id, showing required amenities
app.get('/api/user_required_amenities/:id', async (req, res) => {
    try {
        const {id} = req.params;
        const result = await pool.query(
            'SELECT * FROM user_required_amenities WHERE user_id = $1',
            [id]
        );
        res.json(result.rows);
    }
    catch (err) {
        console.error('Error fetching user amenities: ', err);
        res.status(500).json({error: 'Failed to fetch user amenities'});
    }
});

app.post('/api/user_required_amenities', async (req, res) => {
    try {
        const {amenity_type_id, priority} = req.body;

        if (!amenity_type_id || !priority) {
            return res.status(400).json({error: 'Missing required fields'});
        }

        const amenity_type = await pool.query(
            'SELECT amenity_name FROM amenity_types WHERE amenity_type_id = $1',
            [amenity_type_id]
        );
        if (amenity_type.rows.length === 0) {
            return res.status(404).json({error: 'Amenity type not found'});
        }

        // CONFIRM ABOUT ALLOW DUPLICATES
        // const user_amenities = await pool.query(`
        //     SELECT user_preferred_id FROM user_required_amenities
        //         WHERE user_preferred_id = $1 AND amenity_type_id = $2
        //     `,
        //     [user_id, amenity_type_id]
        // );
        // if (user_amenities.rows.length !== 0) {
        //     return res.status(409).json({error: 'Required amenities already defined for user'});
        // }

        const result = await pool.query(`
            INSERT INTO user_required_amenities (amenity_type_id, priority)
            VALUES ($1, $2)
            RETURNING *
            `,
            [user_id, priority]
        );
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

app.post('/api/recommendations', async (req, res) => {
    try {
        const {user_id, location_id, recommendation_score} = req.body;

        if (!user_id || !location_id || !recommendation_score) {
            return res.status(400).json({error: 'Missing required fields'});
        }

        const user = await pool.query(
            'SELECT user_id FROM users WHERE user_id = $1',
            [user_id]
        );
        if (user.rows.length === 0) {
            return res.status(404).json({error: 'User not found'});
        }

        const location = await pool.query(
            'SELECT name FROM locations WHERE location_id = $1',
            [location_id]
        );
        if (location.rows.length === 0) {
            return res.status(404).json({error: 'Location not found'});
        }

        const result = await pool.query(`
            INSERT INTO recommendations (user_id, location_id, recommendation_score)
            VALUES ($1, $2, $3)
            RETURNING *
            `,
            [user_id, location_id, recommendation_score]
        );
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
        res.json(result.rows);
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
    if (avgNoise < 4) return 'QUIET';
    if (avgNoise > 7) return 'COLLABORATIVE';
    return 'MIXED';
}


// USER REPORTS ENDPOINTS


// Submit a report — protected, uses user_id from JWT (not request body)
app.post('/api/reports', authenticateToken, async (req, res) => {
    try {
        const { location_id, noise_level, crowd_level } = req.body;
        const user_id = req.user.user_id; // from JWT payload

        if (!location_id || !noise_level) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (noise_level < 1 || noise_level > 10) {
            return res.status(400).json({ error: 'Noise level must be between 1 and 10' });
        }

        const result = await pool.query(`
            INSERT INTO user_reports (user_id, location_id, noise_level, crowd_level, report_timestamp)
            VALUES ($1, $2, $3, $4, NOW())
            RETURNING *
        `, [user_id, location_id, noise_level, crowd_level || 'medium']);

        res.status(201).json({
            message: 'Report submitted successfully',
            report: result.rows[0]
        });

    } catch (err) {
        console.error('Error submitting report:', err);
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

// Get recent reports for a location (fixed SQL injection in INTERVAL)
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

        res.json({
            message: 'Checked out successfully',
            checkOut: {
                ...result.rows[0],
                durationMinutes
            }
        });

    } catch (err) {
        console.error('Error checking out:', err);
        res.status(500).json({ error: 'Failed to check out' });
    }
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

// ERROR HANDLING

app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// START SERVER

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Auth:     POST /api/register | POST /api/login | POST /api/token | DELETE /api/logout`);
    console.log(`Check-in: POST /api/checkin  | POST /api/checkout | GET /api/checkin/status | GET /api/checkin/history`);
    console.log(`Reports:  POST /api/reports (protected) | GET /api/locations/:id/reports`);
});