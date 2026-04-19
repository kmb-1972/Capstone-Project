require('dotenv').config({ path: '../.env' });
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    ssl: { rejectUnauthorized: false }
});


async function seedDemoData() {
    function minutesAgo(minutes) {
        return new Date(Date.now() - minutes * 60000).toISOString();
    }
    function daysAgo(days) {
        return new Date(Date.now() - days * 24*60*60*1000);
    }
    try {
        // console.log('Seeding demo data for time relevancy feature...\n');


        // CREATE TEST USER
        // console.log('Creating test user...');
        const userResult = await pool.query(`
            INSERT INTO users (email, password_hash, created_at)
            VALUES ('demo@studyspots.com', 'hashed_password_demo', NOW()) ON CONFLICT (email) DO
            UPDATE SET email = EXCLUDED.email
                RETURNING user_id
        `);
        const userId = userResult.rows[0].user_id;
        // console.log(`User created (ID: ${userId})\n`);

        // CREATE TEST LOCATIONS
        // console.log('Creating test locations...');
        await pool.query(`
            INSERT INTO locations (location_id, name, address, building, volatility_index)
            VALUES (1, 'Main Library', '123 Campus Drive', 'Academic Building A', 0.8),
                   (2, 'Coffee Shop', '456 University Ave', 'Student Center', 0.0),
                   (3, 'Student Union', '789 College Blvd', 'Union Hall', 4.2) ON CONFLICT (location_id) DO
            UPDATE
                SET name = EXCLUDED.name, address = EXCLUDED.address,building = EXCLUDED.building, volatility_index = EXCLUDED.volatility_index
        `);

        // console.log('3 locations created\n');
// amenity types
//         console.log('seeding amenity types...');
        await pool.query(`TRUNCATE amenities RESTART IDENTITY`)
        await pool.query(`DELETE
                          FROM amenity_types`);
        const amenityTypes = [
            {id: 1, name: 'Wifi', description: ' Wireless internet access'},
            {id: 2, name: 'Printers', description: 'Printing stations available'},
            {id: 3, name: 'Coffee', description: 'Coffee available on site'},
            {id: 4, name: 'Bathroom', description: 'Restrooms available'},
            {id: 5, name: 'Whiteboards', description: 'Whiteboards for group work'},
            {id: 6, name: 'Food', description: 'Food available'},
            {id: 7, name: 'Drinks', description: 'Drinks available'},
            {id: 8, name: 'Seating', description: 'Available seating spots'},
            {id: 9, name: 'Outlets', description: 'Power outlets available'},
            {id: 10, name: 'Windows', description: 'Light from windows'},
        ];

        for (const a of amenityTypes) {
            await pool.query(`
                INSERT INTO amenity_types(amenity_type_id, amenity_name, description)
                VALUES ($1, $2, $3) ON CONFLICT (amenity_type_id) DO
                UPDATE
                    SET amenity_name = EXCLUDED.amenity_name
            `, [a.id, a.name, a.description,]);
        }
        // console.log('10 amenity types created\n');

//Amenities, count per location
//         console.log('seeding amenities...');

        await pool.query(`DELETE
                          FROM amenities`)
        const libraryAmenities = [
            {locationId: 1, typeId: 1, count: 1},
            {locationId: 1, typeId: 2, count: 4},
            {locationId: 1, typeId: 3, count: 0},
            {locationId: 1, typeId: 4, count: 3},
            {locationId: 1, typeId: 5, count: 6},
            {locationId: 1, typeId: 8, count: 50},
            {locationId: 1, typeId: 9, count: 60},
            {locationId: 1, typeId: 10, count: 1},
        ];
        const coffeeShopAmenities = [
            {locationId: 2, typeId: 1, count: 1},
            {locationId: 2, typeId: 3, count: 1},
            {locationId: 2, typeId: 4, count: 1},
            {locationId: 2, typeId: 6, count: 1},
            {locationId: 2, typeId: 7, count: 1},
            {locationId: 2, typeId: 8, count: 20},
            {locationId: 2, typeId: 9, count: 8},
            {locationId: 2, typeId: 10, count: 1},
        ];
        const studentUnitAmenities = [
            {locationId: 3, typeId: 1, count: 1},
            {locationId: 3, typeId: 3, count: 1},
            {locationId: 3, typeId: 4, count: 4},
            {locationId: 3, typeId: 5, count: 2},
            {locationId: 3, typeId: 6, count: 1},
            {locationId: 3, typeId: 7, count: 1},
            {locationId: 3, typeId: 8, count: 80},
            {locationId: 3, typeId: 9, count: 15},
        ];
        const allAmenities = [...libraryAmenities, ...coffeeShopAmenities, ...studentUnitAmenities];
        // for (const a of allAmenities) {
        //     await pool.query(`
        //         INSERT INTO amenities(location_id, amenity_type_id, available_count, last_verified)
        //         VALUES ($1, $2, $3, NOW())`, [a.locationId, a.typeId, a.count]);
        // }
       for(const a of libraryAmenities){
           await pool.query(`
           INSERT INTO amenities(location_id, amenity_type_id, available_count, last_verified)
           VALUES($1, $2,$3, NOW())
           `, [a.locationId, a.typeId, a.count]);
       }

       for(const a of coffeeShopAmenities){
           await pool.query(`
           INSERT INTO amenities(location_id, amenity_type_id, available_count, last_verified)
           VALUES($1, $2, $3, $4)
           `, [a.locationId, a.typeId, a.count, daysAgo(45)]);
        }
       for(const a of studentUnitAmenities){
           await pool.query(`
           INSERT INTO amenities(location_id, amenity_type_id, available_count, last_verified)
           VALUES($1, $2, $3, $4)
           `, [a.locationId, a.typeId, a.count, daysAgo(90)]);
       }

        // console.log('Amenities seeded for all 3 locations');

        //User reports
        // console.log('seeding user reports...');
        await pool.query(`DELETE FROM user_reports`);


        const libraryReports = [
            { noise: 1, crowd: 'low',    time: minutesAgo(80), comment: 'Super quiet' },
            { noise: 2, crowd: 'low',    time: minutesAgo(75), comment: 'Very quiet' },
            { noise: 1, crowd: 'low',    time: minutesAgo(70), comment: 'Empty, silent' },
            { noise: 2, crowd: 'low',    time: minutesAgo(65), comment: 'Barely anyone' },
            { noise: 3, crowd: 'low',    time: minutesAgo(60), comment: 'Pretty quiet' },
            { noise: 2, crowd: 'low',    time: minutesAgo(55), comment: 'Quiet morning' },
            { noise: 3, crowd: 'low',    time: minutesAgo(50), comment: 'Good for focus' },
            { noise: 2, crowd: 'low',    time: minutesAgo(45), comment: 'Nice and calm' },
            { noise: 4, crowd: 'medium', time: minutesAgo(40), comment: 'Getting busier' },
            { noise: 3, crowd: 'low',    time: minutesAgo(35), comment: 'Still manageable' },
            { noise: 5, crowd: 'medium', time: minutesAgo(30), comment: 'Some chatter' },
            { noise: 4, crowd: 'medium', time: minutesAgo(25), comment: 'Moderate noise' },
            { noise: 6, crowd: 'medium', time: minutesAgo(20), comment: 'Getting louder' },
            { noise: 4, crowd: 'medium', time: minutesAgo(15), comment: 'a little busy' },
            { noise: 2, crowd: 'low',   time: minutesAgo(10), comment: 'quiet' },
            { noise: 5, crowd: 'medium',   time: minutesAgo(5),  comment: 'a little busy' },
        ];

        const coffeeReports = [
            {noise: 6, crowd: 'medium', time:  daysAgo(15), comment: 'Music playing, moderate chit chat'},
            {noise: 7, crowd: 'high', time:  daysAgo(13), comment: 'Getting more crowded'},
            {noise: 7, crowd: 'high', time:  daysAgo(12), comment: 'A bunch of people here, loud'},
            {noise: 8, crowd: 'high', time:  daysAgo(48), comment: 'Very busy'},
        ];
        const unionReports = [
            {noise: 8, crowd: 'high', time:  daysAgo(90), comment: 'Loud, lots of people'},
            {noise: 9, crowd: 'high', time:  daysAgo(92), comment: 'Loud, lots of people'},
            {noise: 7, crowd: 'high', time:  daysAgo(91), comment: 'Loud, lots of people'},
        ];

        const allReports = [
            ...libraryReports.map(r => ({ ...r, locationId: 1 })),
            ...coffeeReports.map(r => ({ ...r, locationId: 2 })),
            ...unionReports.map(r => ({ ...r, locationId: 3 })),
        ];

        for (const r of allReports) {
            await pool.query(`INSERT INTO user_reports(user_id, location_id, noise_level, crowd_level, report_timestamp, comments)
            VALUES($1, $2, $3, $4, $5,$6)
            `, [userId, r.locationId, r.noise, r.crowd, r.time, r.comment]);
        }
        // console.log('demo data is seeded successfully');
        //
        // console.log("seeding historical location states");
        await pool.query(`INSERT INTO location_states
        (location_id, time_window, avg_noise_level,avg_crowd_level,report_count, last_updated, report_confidence)
        VALUES (2, 'Afternoon', 7.00, 'high', 4, $1, 0.80),
               (3,'Afternoon', 8.00, 'high', 3, $2, 0.60)
               ON CONFLICT(location_id, time_window)
DO UPDATE SET
   avg_noise_level = EXCLUDED.avg_noise_level,
            avg_crowd_level = EXCLUDED.avg_crowd_level,
            report_count = EXCLUDED.report_count,
            last_updated = EXCLUDED.last_updated,
            report_confidence = EXCLUDED.report_confidence
`, [daysAgo(45), daysAgo(90)]);
        // console.log("historical location states seeded successfully");

    }catch (error){
        console.log('Error seeding data:', error);
    }finally{
        await pool.end();
    }
    }
    seedDemoData();
