require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();


// MIDDLEWARE

app.use(express.json());        // Parse JSON request bodies
app.use(cors());                // Allow frontend to connect


// DATABASE CONNECTION POOL

const pool = new Pool({
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

// Test database connection on startup
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('Database connection failed:', err.message);
    } else {
        console.log('Database connected');
    }
});


// BASIC ENDPOINTS


// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'Server is running', timestamp: new Date() });
});

// Test database connection
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


// LOCATION ENDPOINTS


// Get all locations
app.get('/api/locations', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM locations ORDER BY name');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching locations:', err);
        res.status(500).json({ error: 'Failed to fetch locations' });
    }
});

// Get single location by ID
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


// TIME RELEVANCY FEATURE


// Check if location has sufficient RECENT data
app.get('/api/locations/:id/data-sufficiency', async (req, res) => {
    try {
        const { id } = req.params;

        // Query for time-based analysis
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

        // YOUR THRESHOLDS
        const MINIMUM_REPORTS = 10;
        const MAX_DAYS_OLD = 365;

        // Check 1: Sufficient quantity?
        if (recentReports < MINIMUM_REPORTS) {
            return res.json({
                canClassify: false,
                reason: 'INSUFFICIENT_RECENT_DATA',
                message: `Need ${MINIMUM_REPORTS - recentReports} more recent reports`,
                details: {
                    recentReports: recentReports,
                    totalReports: totalReports,
                    requiredReports: MINIMUM_REPORTS
                }
            });
        }

        // Check 2: Data too old?
        const mostRecent = data.most_recent_report;
        const daysSinceLastReport = mostRecent
            ? (Date.now() - new Date(mostRecent)) / (1000 * 60 * 60 * 24)
            : 999;

        if (daysSinceLastReport > MAX_DAYS_OLD) {
            return res.json({
                canClassify: false,
                reason: 'STALE_DATA',
                message: `Last report was ${Math.floor(daysSinceLastReport)} days ago`,
                details: {
                    lastReportDate: mostRecent,
                    daysSinceLastReport: Math.floor(daysSinceLastReport)
                }
            });
        }

        // Check 3: Data too inconsistent?
        const variance = parseFloat(data.noise_variance);
        if (variance > 2.5) {
            return res.json({
                canClassify: false,
                reason: 'INCONSISTENT_DATA',
                message: 'Reports show high variance - experiences vary too much',
                details: {
                    variance: variance.toFixed(2),
                    recentReports: recentReports
                }
            });
        }

        // All checks passed - data is sufficient!
        res.json({
            canClassify: true,
            classification: getClassification(parseFloat(data.recent_avg_noise)),
            details: {
                recentReports: recentReports,
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

// Helper function: Classify based on noise level
function getClassification(avgNoise) {
    if (avgNoise < 4) return 'QUIET';
    if (avgNoise > 7) return 'COLLABORATIVE';
    return 'MIXED';
}


// USER REPORTS ENDPOINTS


// Submit a new report (for testing)
app.post('/api/reports', async (req, res) => {
    try {
        const { user_id, location_id, noise_level, crowd_level } = req.body;

        // Validation
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
        `, [user_id || 1, location_id, noise_level, crowd_level || 'medium']);

        res.status(201).json({
            message: 'Report submitted successfully',
            report: result.rows[0]
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
        const { days } = req.query; // Optional: ?days=7

        const daysFilter = days ? parseInt(days) : 365;

        const result = await pool.query(`
            SELECT
                report_id,
                noise_level,
                crowd_level,
                report_timestamp,
                confidence_score
            FROM user_reports
            WHERE location_id = $1
              AND report_timestamp > NOW() - INTERVAL '${daysFilter} days'
            ORDER BY report_timestamp DESC
        `, [id]);

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


// ERROR HANDLING


// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});


// START SERVER


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    // console.log(` Server running on http://localhost:${PORT}`);
    // console.log(` API endpoints:`);
    // console.log(`   GET  /api/health`);
    // console.log(`   GET  /api/test`);
    // console.log(`   GET  /api/locations`);
    // console.log(`   GET  /api/locations/:id`);
    // console.log(`   GET  /api/locations/:id/data-sufficiency`);
    // console.log(`   GET  /api/locations/:id/reports`);
    // console.log(`   POST /api/reports`);
});