require('dotenv').config({path: '../.env'});
const {Pool} = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    ssl: {rejectUnauthorized: false}
});


//minutes
const REPORT_WINDOW = 90;
const MIN_REPORTS = 2;

const NOISE = {
    LOW: {max: 3.5, label: 'low'},
    MEDIUM: {max: 6, label: 'medium'},
    HIGH: {min: 7, label: 'high'}
};

const CONFIDENCE = {
    HIGH: 0.75,
    MEDIUM: 0.50,
    LOW: 0.25
};

//hours
const AMENITY_EXPIRED_CONFIRMATION = 48;

//these control when we show disclaimers to users abt how fresh the location data is
const STALE_DISCLAIMER_DAYS = 30; // > 30 days we show a disclaimer
const STALE_LOW_CONFIDENCE_DAYS = 60; // > 60 days we should show a low confidence warning


function noiseLevel(level) {
    if (level <= NOISE.LOW.max) return NOISE.LOW.label;
    if (level <= NOISE.MEDIUM.max) return NOISE.MEDIUM.label;
    return NOISE.HIGH.label;
}

function getTimeWindow(date = new Date()) {
    const hour = date.getHours();
    if (hour >= 5 && hour < 12) return 'Morning';
    if (hour >= 12 && hour < 17) return 'Afternoon';
    if (hour >= 17 && hour < 21) return 'Evening';
    return 'night';
}

function getTimeRelevancy(reportTimestamps){

    if(!reportTimestamps || reportTimestamps.length === 0 ){
        return{
            status: 'No data',
            disclaimer: 'No data available for this location',
            confidence: 0.0
        };
    }
    const MS_PER_DAY = 86400000;
    const now = Date.now();

    let weightedSum =0;
    let totalWeight = 0;

    reportTimestamps.forEach((timestamp, index)=> {
        const weight = index + 1;
        const daysOld = (now - new Date(timestamp)) / MS_PER_DAY;
        weightedSum += daysOld * weight;
        totalWeight += weight;
    });

    const weightedAvgDays = weightedSum / totalWeight;
    if(weightedAvgDays <= STALE_DISCLAIMER_DAYS){
        return {
            status: 'fresh data',
            disclaimer: null,
            confidence: 1.0,
            avgDaysOld: Math.round(weightedAvgDays)
        };
    }
        if(weightedAvgDays <= STALE_LOW_CONFIDENCE_DAYS){
            return{
                status: 'more than 1 month old data',
                disclaimer: `Data is on average ${Math.round(weightedAvgDays)} days old, conditions may have changed`,
                confidence: 0.6,
                avgDaysOld: Math.round(weightedAvgDays)
            };
        }
        return {
            staus: 'outdated',
            disclaimer: `low confidence, data is on average ${Math.round(weightedAvgDays)} days old`,
            confidence: 0.3,
            avgDaysOld: Math.round(weightedAvgDays),
        }

}


async function processingVolatileAttributes(locationId) {
    const result = await pool.query(`
        SELECT AVG(noise_level)::DECIMAL(5,2) AS avg_noise, MODE() WITHIN GROUP (ORDER BY crowd_level) AS avg_crowd,
    COUNT(*) AS report_count,
        ARRAY_AGG(report_timestamp ORDER BY report_timestamp ASC) AS timestamps
        FROM user_reports
        WHERE location_id=$1
          AND report_timestamp >= NOW() - INTERVAL '${REPORT_WINDOW} minutes'
          AND noise_level IS NOT NULL
    `, [locationId]);


    const reportCount = parseInt(result.rows[0].report_count);
    if (reportCount < MIN_REPORTS) {
        const historicalDataResult = await pool.query(`
        SELECT avg_noise_level, avg_crowd_level, confidence_level, last_updated FROM location_states WHERE location_id=$1
        ORDER BY last_updated DESC LIMIT 1
        `, [locationId]);

        const lastUpdated = historicalDataResult.rows[0]?.last_updated ?? null;
        // const timeRelevancy = getTimeRelevancy(lastUpdated);
        const historicalTimestampsResult = await pool.query(`
        SELECT report_timestamp 
        FROM user_reports
        WHERE location_id=$1
        ORDER BY report_timestamp ASC
        `, [locationId]);
        const historicalTimeStamps = historicalTimestampsResult.rows.map(r => r.report_timestamp);
        const timeRelevancy = getTimeRelevancy(historicalTimeStamps);

        return {
            updated: false,
            reason: `Only ${reportCount} recent report(s) - need at least ${MIN_REPORTS}`, reportCount,
            historicalData: historicalDataResult.rows[0]? {
                noise: parseFloat(historicalDataResult.rows[0].avg_noise_level).toFixed(1),
                crowd: historicalDataResult.rows[0].avg_crowd_level,
                confidence: parseFloat(historicalDataResult.rows[0].confidence_level)
            } : null, timeRelevancy
        };
    }

    const row = result.rows[0];
    const avgNoise = row.avg_noise;
    const crowdLevel = row.avg_crowd;
    const timeWindow = getTimeWindow();
    const confidenceScore = Math.min(1.0, reportCount / 5).toFixed(2);


    await pool.query(`
        INSERT INTO location_states(location_id, time_window, avg_noise_level, avg_crowd_level, report_count,
                                    last_updated, confidence_level)
        VALUES ($1, $2, $3, $4, $5, NOW(), $6) ON CONFLICT (location_id,time_window)
    DO UPDATE SET
            avg_noise_level = EXCLUDED.avg_noise_level,
            avg_crowd_level = EXCLUDED.avg_crowd_level,
            report_count = EXCLUDED.report_count,
            last_updated = NOW(),
            confidence_level = EXCLUDED.confidence_level
    `, [locationId, timeWindow, avgNoise, crowdLevel, reportCount, confidenceScore]);

    const timeRelevancy = getTimeRelevancy(result.rows[0].timestamps);
    return {
        updated: true,
        reportCount: reportCount,
        noise: avgNoise,
        noiseLabel : `${avgNoise} - ${noiseLevel(parseFloat(avgNoise))}`,
        crowd: crowdLevel,
        timeWindow,
        confidenceScore,
        timeRelevancy
    };
}

async function processStableAttributes(locationId) {
    const amenitiesResult = await pool.query(`
        SELECT a.amenity_id,
               a.available_count,
               a.last_verified,
               at.amenity_name
        FROM amenities a
                 JOIN amenity_types at
        ON a.amenity_type_id = at.amenity_type_id
        WHERE location_id=$1
    `, [locationId]);

    const updates = [];
    for (const amenity of amenitiesResult.rows) {
        const hoursSinceLastUpdated = (Date.now() - new Date(amenity.last_verified)) / 36e5;
        const isStale = Math.abs(hoursSinceLastUpdated) > AMENITY_EXPIRED_CONFIRMATION;
        const hoursAbs = Math.abs(hoursSinceLastUpdated);
        const timeAgoLabel = hoursAbs >= 24 ? `${Math.round(hoursAbs/24)} days ago`:
            `${hoursAbs.toFixed(1)}h ago`;

        if (!isStale) {
            updates.push({
                amenity_id: amenity.amenity_id,
                amenity_name: amenity.amenity_name,
                available_count: amenity.available_count,
                status: 'skipped',
                reason: `Last verified ${timeAgoLabel}`
            });
            continue;
        }
        const stateResult = await pool.query(`
            SELECT confidence_level
            FROM location_states
            WHERE location_id = $1
            ORDER BY last_updated DESC LIMIT 1
        `, [locationId]);

        const confidence = parseFloat(stateResult.rows[0]?.confidence_level ?? 0);

        if (confidence < CONFIDENCE.LOW) {
            updates.push({
                amenity_id: amenity.amenity_id,
                amenity_name: amenity.amenity_name,
                status: `uncertain`,
                reason: 'Low overall location confidence'
            });
            continue;
        }
        await pool.query(`
            UPDATE amenities
            SET last_verified = NOW()
            WHERE amenity_id = $1
        `, [amenity.amenity_id]);
        updates.push({
            amenity_id: amenity.amenity_id,
            amenity_name: amenity.amenity_name,
            available_count: amenity.available_count,
            status: 'refreshed',
            reason: `Was outdated(${timeAgoLabel}), re-verified`
        })
    }

    return {
        locationId: locationId,
        updates: updates
    }
}

async function resolveConflict (locationId) {
    const result = await pool.query(`
    SELECT noise_level, report_timestamp
    FROM user_reports
    WHERE location_id=$1
    AND report_timestamp>=  NOW() - INTERVAL '${REPORT_WINDOW} minutes'
    AND noise_level IS NOT NULL
    ORDER BY report_timestamp DESC 
    `, [locationId]);

    if(result.rows.length === 0){
        return{locationId, conflict:false, reason: 'No recent reports'};
    }
    const noiseLevels = result.rows.map(r => r.noise_level);

    const sorted=[...noiseLevels].sort((a,b)=> a -b);

    const percentile50 = Math.floor(sorted.length * 0.50);
    const percentile95 = Math.floor(sorted.length * 0.95);
    const median = sorted[percentile50];
    const percent95 = sorted[percentile95];


    return{
        locationId,
        reportCount: result.rows.length,
        median,
        percent95,
        noiseLabel: noiseLevel(percent95),
        strategy: 'percentile based',
        interpretation: `The 95th percentile noise level is ${percent95}, labeled as ${noiseLevel(percent95)}`,
    }
}

async function analyzeLocation (locationId) {
    const[volatileResult,
        // stableResult,
        conflictResult] = await Promise.all([
      processingVolatileAttributes(locationId),
        // processStableAttributes(locationId),
        resolveConflict(locationId)
    ]);

    return {
        locationId,
        analyzedAt: new Date().toLocaleDateString('en-US',{
            month:'long',
            day:'numeric',
            year:'numeric',
            hour:'numeric',
            minute:'2-digit',
            hour12:true
        }),
        timeWindow: getTimeWindow(),
        volatileAttributes: volatileResult,
        // stableAttributes: stableResult,
        conflictResolution: conflictResult
    }
}

async function runDemo(){
    try {
        const locations = await pool.query(
            'SELECT location_id, name ' +
            'FROM locations ORDER BY location_id'
        );
        const allResults = [];
        for (const loc of locations.rows) {
            console.log(`Analyzing: ${loc.name}...`);
            const result = await analyzeLocation(loc.location_id);
            allResults.push({locationName: loc.name, ...result});
        }
        console.log(JSON.stringify(allResults, null, 2));
    }catch(error){
        console.error("Analysis failed", error);
    }finally {
        await pool.end();
    }
}
runDemo();

