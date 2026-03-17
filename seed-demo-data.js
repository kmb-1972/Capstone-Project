require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    ssl: { rejectUnauthorized: false }
});

async function seedDemoData() {
    try {
        console.log('Seeding demo data for time relevancy feature...\n');

        // CREATE TEST USER
        console.log('Creating test user...');
        const userResult = await pool.query(`
            INSERT INTO users (email, password_hash, created_at)
            VALUES ('demo@studyspots.com', 'hashed_password_demo', NOW())
            ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
            RETURNING user_id
        `);
        const userId = userResult.rows[0].user_id;
        console.log(`User created (ID: ${userId})\n`);

        // CREATE TEST LOCATIONS
        console.log('Creating test locations...');
        await pool.query(`
            INSERT INTO locations (location_id, name, address, building, volatility_index)
            VALUES 
                (1, 'Main Library', '123 Campus Drive', 'Academic Building A', 0.8),
                (2, 'Coffee Shop', '456 University Ave', 'Student Center', 0.0),
                (3, 'Student Union', '789 College Blvd', 'Union Hall', 3.5)
            ON CONFLICT (location_id) DO UPDATE 
            SET name = EXCLUDED.name, address = EXCLUDED.address, volatility_index = EXCLUDED.volatility_index
        `);
        console.log('3 locations created\n');

        // LOCATION 1: SUFFICIENT RECENT DATA
        console.log('Populating Location 1 (Main Library)...');
        console.log('   Scenario: SUFFICIENT RECENT DATA - Should PASS');

        await pool.query('DELETE FROM user_reports WHERE location_id = 1');

        for (let i = 0; i < 15; i++) {
            const daysAgo = Math.floor(Math.random() * 25);
            const hoursAgo = Math.floor(Math.random() * 24);
            const timestamp = new Date(Date.now() - (daysAgo * 24 + hoursAgo) * 60 * 60 * 1000);
            const noiseLevel = Math.floor(Math.random() * 3) + 1;

            await pool.query(`
                INSERT INTO user_reports (user_id, location_id, noise_level, crowd_level, report_timestamp, comments)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [userId, 1, noiseLevel, 'low', timestamp, 'really quiet, good for studying']);
        }
        console.log('   15 reports (0-25 days old, noise level 1-3)\n');

        // LOCATION 2: INSUFFICIENT DATA
        console.log('Populating Location 2 (Coffee Shop)...');
        console.log('   Scenario: INSUFFICIENT DATA - Should FAIL');

        await pool.query('DELETE FROM user_reports WHERE location_id = 2');

        for (let i = 0; i < 3; i++) {
            const daysAgo = Math.floor(Math.random() * 10);
            const timestamp = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
            const noiseLevel = Math.floor(Math.random() * 4) + 5;

            await pool.query(`
                INSERT INTO user_reports (user_id, location_id, noise_level, crowd_level, report_timestamp, comments)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [userId, 2, noiseLevel, 'medium', timestamp, 'somewhat loud, some chatter']);
        }
        console.log('   Only 3 reports (need 10 minimum)\n');

        // LOCATION 3: STALE DATA
        console.log('Populating Location 3 (Student Union)...');
        console.log('   Scenario: STALE DATA - Should FAIL');

        await pool.query('DELETE FROM user_reports WHERE location_id = 3');

        for (let i = 0; i < 20; i++) {
            const daysAgo = Math.floor(Math.random() * 45) + 365;
            const timestamp = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
            const noiseLevel = Math.floor(Math.random() * 4) + 7;

            await pool.query(`
                INSERT INTO user_reports (user_id, location_id, noise_level, crowd_level, report_timestamp, comments)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [userId, 3, noiseLevel, 'high', timestamp, 'Very loud, hard to focus']);
        }
        console.log('   20 reports BUT all 365+ days old\n');

        console.log('====================================================');
        console.log('DEMO DATA SEEDED SUCCESSFULLY!\n');
        console.log('TEST YOUR TIME RELEVANCY FEATURE:\n');
        console.log('Location 1: GET http://localhost:3000/api/locations/1/data-sufficiency');
        console.log('   Expected: canClassify=true, classification=QUIET\n');
        console.log('Location 2: GET http://localhost:3000/api/locations/2/data-sufficiency');
        console.log('   Expected: canClassify=false (insufficient data)\n');
        console.log('Location 3: GET http://localhost:3000/api/locations/3/data-sufficiency');
        console.log('   Expected: canClassify=false (stale data)\n');
        console.log('====================================================');

    } catch (err) {
        console.error('Error seeding data:', err);
    } finally {
        pool.end();
    }
}

seedDemoData();
