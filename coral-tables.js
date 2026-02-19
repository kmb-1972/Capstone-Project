require('dotenv').config();
const {Pool} = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    user: process.env.DB_USER ,
    password: process.env.DB_PASS,
    ssl: {rejectUnauthorized: false}
});

async function createSchema() {
    try {
        console.log('Creating schema...');

        // 1. Users table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users
            (
                user_id
                SERIAL
                PRIMARY
                KEY,
                email
                VARCHAR
            (
                255
            ) UNIQUE NOT NULL,
                password_hash VARCHAR
            (
                255
            ) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW
            (
            ),
                last_login TIMESTAMP
                )
        `);

        // 2. Locations table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS locations
            (
                location_id
                SERIAL
                PRIMARY
                KEY,
                name
                VARCHAR
            (
                255
            ) NOT NULL,
                address TEXT
                )
        `);

        // 3. Amenity types table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS amenity_types
            (
                amenity_type_id
                SERIAL
                PRIMARY
                KEY,
                amenity_name
                VARCHAR
            (
                100
            ) NOT NULL,
                description TEXT
                )
        `);

        // 4. Amenities table (references locations and amenity_types)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS amenities
            (
                amenity_id
                SERIAL
                PRIMARY
                KEY,
                location_id
                INTEGER
                REFERENCES
                locations
            (
                location_id
            ),
                amenity_type_id INTEGER REFERENCES amenity_types
            (
                amenity_type_id
            ),
                is_available BOOLEAN DEFAULT TRUE,
                last_verified TIMESTAMP DEFAULT NOW
            (
            )
                )
        `);

        // 5. Check-ins table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS check_ins
            (
                check_in_id
                SERIAL
                PRIMARY
                KEY,
                user_id
                INTEGER
                REFERENCES
                users
            (
                user_id
            ),
                location_id INTEGER REFERENCES locations
            (
                location_id
            ),
                check_in_time TIMESTAMP DEFAULT NOW
            (
            ),
                check_out_time TIMESTAMP,
                follow_up_completed BOOLEAN DEFAULT FALSE
                )
        `);

        // 6. User preferences table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_preferences
            (
                preference_id
                SERIAL
                PRIMARY
                KEY,
                user_id
                INTEGER
                REFERENCES
                users
            (
                user_id
            ),
                noise_level INTEGER CHECK
            (
                noise_level
                BETWEEN
                1
                AND
                10
            ),
                crowd_level VARCHAR
            (
                50
            )
                )
        `);

        // 7. User reports table (KEY FOR TIME RELEVANCY)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_reports
            (
                report_id
                SERIAL
                PRIMARY
                KEY,
                user_id
                INTEGER
                REFERENCES
                users
            (
                user_id
            ),
                location_id INTEGER REFERENCES locations
            (
                location_id
            ),
                noise_level INTEGER CHECK
            (
                noise_level
                BETWEEN
                1
                AND
                10
            ),
                crowd_level VARCHAR
            (
                50
            ),
                report_timestamp TIMESTAMP DEFAULT NOW
            (
            ),
                confidence_score DECIMAL
            (
                5,
                2
            )
                )
        `);

        // 8. User required amenities table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_required_amenities
            (
                user_preferred_id
                SERIAL
                PRIMARY
                KEY,
                amenity_type_id
                INTEGER
                REFERENCES
                amenity_types
            (
                amenity_type_id
            ),
                priority INTEGER
                )
        `);

        // 9. Recommendations table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS recommendations
            (
                recommendation_id
                SERIAL
                PRIMARY
                KEY,
                user_id
                INTEGER
                REFERENCES
                users
            (
                user_id
            ),
                location_id INTEGER REFERENCES locations
            (
                location_id
            ),
                timestamp TIMESTAMP DEFAULT NOW
            (
            ),
                was_accepted BOOLEAN,
                recommendation_score DECIMAL
            (
                5,
                2
            )
                )
        `);

        // 10. Location states table (IMPORTANT FOR YOUR TIME RELEVANCY FEATURE)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS location_states
            (
                state_id
                SERIAL
                PRIMARY
                KEY,
                location_id
                INTEGER
                REFERENCES
                locations
            (
                location_id
            ),
                time_window VARCHAR
            (
                50
            ),
                avg_noise_level DECIMAL
            (
                5,
                2
            ),
                avg_crowd_level VARCHAR
            (
                50
            ),
                report_count INTEGER,
                last_updated TIMESTAMP DEFAULT NOW
            (
            ),
                confidence_level DECIMAL
            (
                5,
                2
            )
                )
        `);

        // Create indexes for performance
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_user_reports_location
                ON user_reports(location_id)
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_user_reports_timestamp
                ON user_reports(report_timestamp)
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_location_states_location
                ON location_states(location_id)
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_check_ins_location
                ON check_ins(location_id, check_in_time)
        `);

        // Verify all tables exist
        const result = await pool.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);

        console.log('\All tables in database:');
        result.rows.forEach(row => console.log(`   - ${row.table_name}`));

    } catch (err) {
        console.error('Error creating schema:', err);
    } finally {
        pool.end();
    }
}

createSchema();