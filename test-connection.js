require('dotenv').config({ path: ".env" });
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    user: process.env.DB_USER ,
    password: process.env.DB_PASS,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});
console.log('HOST:', process.env.DB_HOST);

pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('Connection failed:', err);
    } else {
        console.log('Database connected!');
        console.log('Current time from DB:', res.rows[0].now);
    }
    pool.end();
});