import 'bootstrap/dist/css/bootstrap.min.css'
import 'bootstrap/dist/js/bootstrap.bundle.js'
import {useEffect, useRef, useState} from 'react';
import { checkIn, checkOut, getCheckinStatus, submitReport, getLocations, getLocationStateById, getAmenityTypes, getAmenitiesByLocation, getUserPreferences, getUserRequiredAmenities, fetchWithRefresh, authHeaders } from '../api.js';
import {useNavigate} from "react-router-dom";


function getCrowdBadge(crowd_level) {
    if (crowd_level === 'low') return 'badge bg-success';
    if (crowd_level === 'medium') return 'badge bg-warning text-dark';
    return 'badge bg-danger';
}


function getNoiseBadge(noise_level) {
    if (noise_level <= 3.5) return {label: 'Quiet', color: 'badge bg-success'};
    if (noise_level <= 6 && noise_level > 3.5) return {label: 'Moderate', color: 'badge bg-warning text-dark'};
    return {label: 'Loud', color: 'badge bg-danger'};
}

function getLocationEmoji(name) {
    if (name.toLowerCase().includes('library')) return '📚';
    if (name.toLowerCase().includes('coffee')) return '☕️';
    if (name.toLowerCase().includes('union')) return '🏫';
    if (name.toLowerCase().includes('science')) return '🔬';
    if (name.toLowerCase().includes('society')) return '🍵';
    if (name.toLowerCase().includes('public library')) return '🏫';
    return '📍';
}


export default function Locations() {

    const [search, setSearch] = useState('');
    const [showDropdown, setShowDropdown] = useState(false);
    const [checkedInId, setCheckedInId] = useState(null);
    const [checkInMessage, setCheckInMessage] = useState('');
    const [locations, setLocations] = useState([]);
    const [locationStates, setLocationStates] = useState([]);
    const [loading, setLoading] = useState(true);
    const navigate = useNavigate();

    useEffect(() => {
        Promise.all([
            getLocations(),
            getAmenityTypes()
        ]).then(async ([locData, amenityTypes]) => {
            const locationsWithAmenities = await Promise.all(
                locData.map(async loc => {
                    const amenityData = await getAmenitiesByLocation(loc.location_id);
                    const amenityNames = amenityData.map(a => {
                        const type = amenityTypes.find(t => t.amenity_type_id === a.amenity_type_id);
                        return type ? type.amenity_name : 'Unknown';
                    });
                    return {...loc, amenities: amenityNames};
                })
            );
            const allStates = await Promise.all(
                locData.map(loc => getLocationStateById(loc.location_id))
            );

            setLocations(locationsWithAmenities);
            setLocationStates(allStates.flat());
            setLoading(false);
        });
    }, []);


//Digital timer clock thingy
    const [checkInTime, setCheckInTime] = useState(null);
    const [elapsedTime, setElapsedTime] = useState('');

    useEffect(() => {
        if (!checkInTime) return;

        const interval = setInterval(() => {
            const now = new Date();
            const diff = Math.floor((now - new Date(checkInTime)) / 1000);
            const hrs = Math.floor(diff / 3600);
            const mins = Math.floor((diff % 3600) / 60);
            const secs = diff % 60;

            setElapsedTime(
                `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
            );
        }, 1000);
        return () => clearInterval(interval);
    }, [checkInTime]);


//feedback modal state
    const [showFeedback, setShowFeedback] = useState(false);
    const [noiseLevel, setNoiseLevel] = useState(5);
    const [crowdLevel, setCrowdLevel] = useState('');
    const [feedbackError, setFeedbackError] = useState('');
    const [feedbackSuccess, setFeedbackSuccess] = useState('');
    const [lastCheckedOutLocationId, setLastCheckedOutLocationId] = useState(null);

    const mapRef = useRef(null);
    const mapObjRef = useRef(null);
    const checkedInFromRecRef = useRef(false);

    useEffect(() => {
        getCheckinStatus().then(status => {
            if (status.checkedIn) setCheckedInId(status.session.location_id);
        }).catch(() => {
        });
    }, []);



//initializing leaflet map from notes
    useEffect(() => {
        if (!window.L) return;
        if (mapObjRef.current) return;
        if (!mapRef.current) return;

        const map = window.L.map(mapRef.current).setView([41.755053392185545, -88.34935601583805], 15);
        mapObjRef.current = map;

        window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(map);

        locations.forEach(loc => {
            const emoji = getLocationEmoji(loc.name);
            const state = getLocationState(loc.location_id);
            const noiseValue = state?.conflict_noise_label
                ? state.conflict_noise_label
                : getNoiseBadge(parseFloat(state?.avg_noise_level) || 0).label.toLowerCase();

            const noise = state?.conflict_noise_label
                ? { label: state.conflict_noise_label.charAt(0).toUpperCase() + state.conflict_noise_label.slice(1),
                    color: state.conflict_noise_label === 'low' ? 'badge bg-success' :
                        state.conflict_noise_label === 'medium' ? 'badge bg-warning text-dark' : 'badge bg-danger' }
                : getNoiseBadge(parseFloat(state?.avg_noise_level) || 0);
            const crowd = state?.avg_crowd_level || 'unknown';

            const icon = window.L.divIcon({
                className: '',
                html: `<div style="
                    background: #2d6a4f;
                    color: white;
                    border-radius: 50%;
                    width: 36px;
                    height: 36px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 18px;
                    box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                    border: 2px solid white;">${emoji}</div>`,
                iconSize: [36, 36],
                iconAnchor: [18, 18],
            });

            window.L.marker([loc.lat, loc.lng], {icon})
                .addTo(map)

                .bindPopup(`<b>${emoji} ${loc.name}</b><br/>Noise: ${noise.label}<br/>Crowd: ${crowd}`);
        });

        return () => {
            if (mapObjRef.current) {
                mapObjRef.current.remove();
                mapObjRef.current = null;
            }
        };
    }, [locations, locationStates]);
    const filteredLocations = locations.filter(loc => loc.name.toLowerCase().includes(search.toLowerCase()));

    function handleSearchSelect(name) {
        setSearch(name);
        setShowDropdown(false);
    }

    function handleSearchSubmit(e) {
        e.preventDefault();
    }

    async function handleCheckIn(locationId) {
        try {
            const result = await checkIn(locationId);

            if (result.message) {
                setCheckedInId(locationId);
                setCheckInTime(new Date().toISOString());
                setCheckInMessage(`Checked in to ${result.checkIn.locationName}!`);
                setShowReport(true);
                setReportNoise(5);
                setReportCrowd('');
                setReportAmenities([]);
                setReportError('');
                setReportSuccess('');
            } else {
                setCheckInMessage(result.error || 'failed to check in');
            }
        } catch {
            setCheckInMessage('Something went wrong.');
        }
        setTimeout(() => setCheckInMessage(''), 3000);
    }

    async function handleCheckOut() {

        try {
            const result = await checkOut();
            if (result.message) {
                setLastCheckedOutLocationId(checkedInId);
                setCheckedInId(null);
                setCheckInTime(null);
                setElapsedTime('');
                setCheckInMessage(`Checked out! You were there for ${result.checkOut.durationMinutes} minutes.`);
                // followup available only if user checked in from a recommendation
                if (checkedInFromRecRef.current) {
                    setShowFeedback(true);
                    setNoiseLevel(5);
                    setCrowdLevel('');
                    setFeedbackError('');
                    setFeedbackSuccess('');

                }
                checkedInFromRecRef.current = false;
            } else {
                setCheckInMessage(result.error || 'Failed to check out.');
            }
        } catch {
            setCheckInMessage('Something went wrong.');
        }
        setTimeout(() => setCheckInMessage(''), 3000);
    }

    async function handleFeedbackSubmit() {
        setFeedbackError('');
        setFeedbackSuccess('');

        if (!crowdLevel) {
            setFeedbackError('Please select a crowd level before submitting.');
            return;
        }

        if (!lastRecommendationId) {
            setFeedbackError('No recommendation ID found. Please check out first.');
            return;
        }

        const payload = {
            recommendation_id: lastRecommendationId,
            curr_noise_level: noiseLevel,
            curr_crowd_level: crowdLevel,
        };

        try {
            const res = await fetch(`${import.meta.env.VITE_API_URL}/api/followup`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok) {
                setFeedbackError(data.error || 'Submission failed. Please try again.');
                return;
            }
            setFeedbackSuccess('Report submitted — thanks for helping keep our data accurate!');
        } catch {
            setFeedbackError('Network error. Please try again.');
        }
    }

    function getLocationState(locationId) {
        const currentHour = new Date().getHours();
        const currentWindow = currentHour >= 17 ? 'Evening' : currentHour >= 12 ? 'Afternoon' : currentHour >= 5 ? 'Morning' : 'night';;
        const states = locationStates.filter(s => Number(s.location_id) === Number(locationId));

        return states.find(s => s.time_window === currentWindow)
            || states.sort((a, b) => new Date(b.last_updated) - new Date(a.last_updated))[0];
    }

    // userReports modal
    const [showReport, setShowReport] = useState(false);
    const [reportNoise, setReportNoise] = useState(5);
    const [reportCrowd, setReportCrowd] = useState('');
    const [reportAmenities, setReportAmenities] = useState([]);
    const [reportComments, setReportComments] = useState('');
    const [reportError, setReportError] = useState('');
    const [reportSuccess, setReportSuccess] = useState('');

    function toggleReportAmenity(id) {
        setReportAmenities(prev => prev.includes(id) ? prev.filter(a => a != id) : [...prev, id]
        );
    }

    async function handleReportSubmit() {
        setReportError('');
        if (!reportCrowd) {
            setReportError('Please select a crowd level before submitting.');
            return;
        }
        try {
            const result = await submitReport({
                location_id: checkedInId,
                noise_level: reportNoise,
                crowd_level: reportCrowd,
                comments: reportComments,
                amenities_available: reportAmenities,
            });
            if (result.message) {
                setReportSuccess('Report submitted! Thanks for helping others.');
            } else {
                setReportError(result.error || "Failed to submit report.");
            }
        } catch {
            setReportError('Something went wrong.');
        }
    }

// Recommendation modal
    const [showRec, setShowRec] = useState(false);
    const[recLoading, setRecLoading] = useState(false);
    const [recResults, setRecResults] = useState([]);
    const[recError, setRecError] = useState('');
    const[noPreferences, setNoPreferences] = useState(false);
    const [lastRecommendationId, setLastRecommendationId] = useState(null);

    async function handleGetRecommendation() {
        setShowRec(true);
        setRecLoading(true);
        setRecError('');
        setRecResults([]);
        setNoPreferences(false);


        try {
            const data = await fetchWithRefresh(`${import.meta.env.VITE_API_URL}/api/recommendations/generate`, {
                method: 'GET',
                headers: authHeaders()
            });


            if (data.error && data.error.includes('No preferences')) {
                setNoPreferences(true);
            } else if (data.results && data.results.length > 0) {
                setRecResults(data.results);
                setLastRecommendationId(data.recommendation_id);

            } else {
                setRecError(data.message || 'No locations matched your preferences.');
            }
        } catch (e) {
            setRecError('Something went wrong. Please try again.');
        }
        setRecLoading(false);
    }

    if (loading) return <p className="text-center mt-5">Loading...</p>;
    return (
        <div className={"container py-4 amenitiesText" }>
            <div className="mb-4 locationsText">
                <h2 className="fw-bold text-dark amenitiesText"> Locations </h2>
                <p className='text-dark amenitiesText '> Browse available study spots and their current status </p>
            </div>
            {checkInMessage && (
                <div className="alert alert-success">{checkInMessage}</div>
            )}

            {/*{search bar}*/}
            <div className="mb-4 position-relative" style={{maxWidth: 500}}>
                <form onSubmit={handleSearchSubmit}>
                    <div className="input-group">
                        <input type="text" className="form-control" placeholder="Search for locations"
                               value={search}
                               onChange={e => {
                                   setSearch(e.target.value);
                                   setShowDropdown(e.target.value.length > 0);
                               }}
                               onFocus={() => setShowDropdown(search.length > 0)}
                               onBlur={() => setTimeout(() => setShowDropdown(false), 150)}/>

                        <button className="btn searchButton" type="submit"> Search</button>
                    </div>
                </form>


                {/* search bar*/}
                {showDropdown && filteredLocations.length > 0 && (
                    <ul className="list-group position-absolute w-100 shadow" style={{zIndex: 100, top: '100%'}}>
                        {filteredLocations.map((loc, i) => (
                            <li key={i}
                                className="list-group-item list-group-item-action"
                                style={{cursor: 'pointer'}}
                                onMouseDown={() => handleSearchSelect(loc.name)}>
                                {loc.name}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* preferences card */}
            <div className="d-flex gap-3 mb-4 ">
                <div className="card preferencesCard flex-grow-1">
                    <div className="card-body">
                        <h5 className="card-title amenitiesText">Preferences</h5>
                        <p className="card-text amenitiesText">Find locations based on your preferences</p>
                        <button className="btn searchButton amenitiesText" onClick={() => navigate('/preferences')}>
                            Set preferences
                        </button>
                    </div>
                </div>

                {/* recommendation card */}
                <div className="card preferencesCard flex-grow-1">
                    <div className="card-body">
                        <h5 className="card-title amenitiesText">Get a Recommendation</h5>
                        <p className="card-text amenitiesText">Find your best study spot based on your preferences</p>
                        <button className="btn searchButton amenitiesText" onClick={handleGetRecommendation}>
                            Get Recommendation
                        </button>
                    </div>
                </div>
            </div>


            {/* Recommendation Modal */}
            {showRec && (
                <div
                    className="d-flex align-items-center justify-content-center"
                    style={{position: 'fixed', inset: 0, backgroundColor: 'rgba(107,143,113,0.5)', zIndex: 1050}}
                >
                    <div className="card border-0 shadow-lg report-modal-card"
                         style={{position: 'relative', maxHeight: '90vh', overflowY: 'auto'}}>
                        <div className="card-body p-4">
                            <button
                                className="btn-close position-absolute top-0 end-0 m-3"
                                onClick={() => setShowRec(false)}
                            />

                            <h5 className="report-modal-title mb-1"> Your Recommendation</h5>
                            <p className="report-modal-subtitle mb-4 small">
                                Based on your saved preferences here are your best study spots.
                            </p>

                            {/* loading state */}
                            {recLoading && (
                                <p className="report-modal-subtitle">Finding your best spots...</p>
                            )}

                            {/* no preferences saved */}
                            {noPreferences && (
                                <div>
                                    <p className="report-modal-subtitle mb-3">
                                        You haven't set any preferences yet! Set them up first so we can find your
                                        perfect spot.
                                    </p>
                                    <button
                                        className="btn report-btn-submit w-100"
                                        onClick={() => {
                                            setShowRec(false);
                                            navigate('/preferences');
                                        }}
                                    >
                                        Set Up Preferences
                                    </button>
                                </div>
                            )}

                            {/* error state */}
                            {recError && <div className="alert alert-warning">{recError}</div>}

                            {/* results */}
                            {recResults.length > 0 && (
                                <div>
                                    {recResults.map((loc, i) => (
                                        <div key={loc.locationId} className="card mb-3"
                                             style={{
                                                 backgroundColor: i === 0 ? 'rgba(107,143,113,0.3)' : 'rgba(107,143,113,0.15)',
                                                 border: '1px solid #8FBF8F',
                                                 borderRadius: '12px'
                                             }}>
                                            <div className="card-body p-3">
                                                <div className="d-flex justify-content-between align-items-center mb-2">
                                                    <h6 className="report-modal-title mb-0">
                                                         {loc.locationName}
                                                    </h6>
                                                    <span className="badge"
                                                          style={{backgroundColor: '#6b8f71', color: 'white'}}>
                                            {loc.matchScore} match
                                        </span>
                                                </div>
                                                {/* show which preferences were met */}
                                                <div className="d-flex flex-wrap gap-1">
                                                    {loc.preferences.map((p, j) => (
                                                        <span key={j} className="badge"
                                                              style={{
                                                                  backgroundColor: p.met ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)',
                                                                  color: p.met ? '#166534' : '#991b1b',
                                                                  border: `1px solid ${p.met ? '#4ade80' : '#f87171'}`,
                                                                  fontSize: '0.7rem'
                                                              }}>
                                               {p.met ? '✅' : '❌'} {p.preference.includes('noise_level')
                                                            ? `noise: ${p.preference.split(':')[1]}`
                                                            : p.preference.includes('crowd_level') ? `crowd: ${p.preference.split(':')[1]}` : p.preference.split(':')[1]?.split('(')[0]?.trim() || p.preference
                                                        }
                                            </span>
                                                    ))}
                                                </div>
                                                {/* check in rec button */}
                                                <button
                                                    className="btn btn-sm w-100 mt-2"
                                                    style={{backgroundColor: '#6b8f71', color: 'white'}}
                                                    onClick={() => {
                                                        checkedInFromRecRef.current = true;
                                                        handleCheckIn(loc.locationId);
                                                    }}
                                                    disabled={checkedInId !== null}
                                                >
                                                    {checkedInId !== null ? 'Already Checked In' : ' Check In Here'}
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}


            <div className="row g-4">
                <div className="col-md-5">
                    {/* Leaflet Map */}
                    <div ref={mapRef} style={{height: '350px', borderRadius: '12px'}}/>
                </div>
                {/* Location Cards */}
                <div className="col-md-7">
                    <div className="row g-3">
                        {filteredLocations.map(loc => {
                            const state = getLocationState(loc.location_id);
                            const noise = state?.conflict_noise_label
                                ? {
                                    label: state.conflict_noise_label.charAt(0).toUpperCase() + state.conflict_noise_label.slice(1),
                                    color: state.conflict_noise_label === 'low' ? 'badge bg-success' :
                                        state.conflict_noise_label === 'medium' ? 'badge bg-warning text-dark' : 'badge bg-danger'
                                }
                                : getNoiseBadge(parseFloat(state?.avg_noise_level) || 0);
                            const crowd = state?.avg_crowd_level || 'unknown';
                            const isCheckedIn = checkedInId === loc.location_id;
                            return (
                                <div key={loc.location_id} className="col-md-6">
                                    <div className="card bg-dark text-white border-0 shadow h-100">
                                        <div className="card-body locationCardName">
                                            <h5 className="card-title fw-bold mb-3">
                                                {loc.name}
                                            </h5>
                                            <div className="d-flex gap-2 mb-3">
                                                <span className={noise.color}> {noise.label}</span>
                                                <span className={getCrowdBadge(crowd)}> {crowd} crowd</span>
                                            </div>
                                            {/* warning if location is known to change frequently */}
                                            {parseFloat(loc.volatility_index) > 0.5 && (
                                                <div className="alert alert-warning py-1 px-2 mb-2 small">
                                                    ⚠️ This location's status changes frequently — conditions may vary!
                                                </div>
                                            )}
                                            {/* warning if data is old — based on disclaimer from backend */}
                                            {state && state.disclaimer && (
                                                <div className="alert alert-danger py-1 px-2 mb-2 small">
                                                     {state.disclaimer}
                                                </div>
                                            )}

                                            <p className="mb-2 small amenitiesText">Amenities:</p>
                                            <div className="d-flex flex-wrap gap-2 mb-3">
                                                {(loc.amenities || []).map((amenity, i) => (
                                                    <span key={i} className="badge amenityBadges ">{amenity}</span>
                                                ))}
                                            </div>
                                            {isCheckedIn ? (
                                                <>
                                                    {/* timer — only shows when user is checked in and timer has started */}
                                                    {elapsedTime && (
                                                        <div className="text-center mb-2">
                                                            <small className="text-white-50">Time here:</small>
                                                            <div className="fw-bold fs-5"
                                                                 style={{fontFamily: 'monospace'}}>{elapsedTime}</div>
                                                        </div>
                                                    )}
                                                    <button className="btn btn-warning w-100 mt-2"
                                                            onClick={handleCheckOut}>
                                                        Check Out
                                                    </button>
                                                </>
                                            ) : (
                                                <button
                                                    className="btn btn-success w-100 mt-2"
                                                    //  regular check in button:
                                                    onClick={() => {
                                                        checkedInFromRecRef.current = false;
                                                        handleCheckIn(loc.location_id);
                                                    }}
                                                    disabled={checkedInId !== null}
                                                >
                                                    {checkedInId !== null ? 'Already Checked In Elsewhere' : 'Check In'}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        {filteredLocations.length === 0 && (
                            <div className="col">
                                <p className="text-muted">No locations found.</p>
                            </div>
                        )}
                    </div>
                </div>

            </div>

            {/* Feedback Modal — pops up after checkout and only if user clicked on recommended */}
            {showFeedback && (
                <div
                    className="d-flex align-items-center justify-content-center"
                    style={{position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 1050}}
                >
                    <div className="card bg-dark text-white border-0 shadow"
                         style={{maxWidth: 480, width: '100%', position: 'relative'}}>
                        <div className="card-body p-4">
                            <button
                                className="btn-close btn-close-white position-absolute top-0 end-0 m-3"
                                onClick={() => setShowFeedback(false)}
                            />

                            <h5 className="fw-bold mb-1">Post-Visit Report</h5>
                            <p className="text-white-50 mb-4 small">
                                Let us know if the noise and crowd levels matched what you experienced.
                            </p>

                            {/* Noise Slider */}
                            <div className="mb-4">
                                <label className="form-label">
                                    Noise Level: <strong>{noiseLevel}</strong>/10
                                </label>
                                <input
                                    type="range"
                                    className="form-range"
                                    min="1" max="10" step="1"
                                    value={noiseLevel}
                                    onChange={e => setNoiseLevel(Number(e.target.value))}
                                    disabled={!!feedbackSuccess}
                                />
                                <div className="d-flex justify-content-between">
                                    <small className="text-white-50">1 — Very Quiet</small>
                                    <small className="text-white-50">10 — Very Loud</small>
                                </div>
                            </div>

                            {/* Crowd Dropdown */}
                            <div className="mb-4">
                                <label className="form-label">Crowd Level:</label>
                                <select
                                    className="form-select bg-dark text-white border-secondary"
                                    value={crowdLevel}
                                    onChange={e => setCrowdLevel(e.target.value)}
                                    disabled={!!feedbackSuccess}
                                >
                                    <option value="" disabled>Select a crowd level</option>
                                    <option value="low">Low</option>
                                    <option value="medium">Medium</option>
                                    <option value="high">High</option>
                                </select>
                            </div>

                            {feedbackError && <div className="alert alert-danger py-2">{feedbackError}</div>}
                            {feedbackSuccess && <div className="alert alert-success py-2">{feedbackSuccess}</div>}

                            <div className="d-flex justify-content-end gap-2">
                                <button className="btn btn-outline-light" onClick={() => setShowFeedback(false)}>
                                    Skip
                                </button>
                                <button
                                    className="btn btn-success"
                                    onClick={handleFeedbackSubmit}
                                    disabled={!!feedbackSuccess}
                                >
                                    Submit
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}


            {/*{report modal - should pop up after check in}*/}
            {showReport && (
                <div className="d-flex align-items-center justify-content-center"
                     style={{position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1050}}>
                    <div className="card bg-dark text-white border-0 shadow"
                         style={{
                             maxWidth: 500,
                             width: '100%',
                             position: 'relative',
                             maxHeight: '90vh',
                             overflowY: 'auto'
                         }}>

                        <div className="card border-0 shadow-lg report-modal-card p-4"
                             style={{position: 'relative', maxHeight: '90vh', overflowY: 'auto'}}>
                            <button
                                className="btn-close position-absolute top-0 end-0 m-3"
                                onClick={() => setShowReport(false)}
                            />
                            <h5 className="report-modal-title mb-1">📍 Submit a Report</h5>
                            <p className="report-modal-subtitle mb-4 small">
                                Let others know what it's like right now at this location.
                            </p>

                            {/* Noise Slider */}
                            <div className="mb-3">
                                <label className="form-label report-modal-label">
                                    Noise Level: <strong>{reportNoise}</strong>/10
                                </label>
                                <input
                                    type="range"
                                    className="form-range"
                                    min="1" max="10" step="1"
                                    value={reportNoise}
                                    onChange={e => setReportNoise(Number(e.target.value))}
                                    disabled={!!reportSuccess}
                                />
                                <div className="d-flex justify-content-between">
                                    <small className="report-modal-hint">1 — Very Quiet</small>
                                    <small className="report-modal-hint">10 — Very Loud</small>
                                </div>
                            </div>

                            {/* Crowd Dropdown */}
                            <div className="mb-3">
                                <label className="form-label report-modal-label">Crowd Level:</label>
                                <select
                                    className="form-select report-modal-select"
                                    value={reportCrowd}
                                    onChange={e => setReportCrowd(e.target.value)}
                                    disabled={!!reportSuccess}
                                >
                                    <option value="" disabled>Select a crowd level</option>
                                    <option value="low">Low</option>
                                    <option value="medium">Medium</option>
                                    <option value="high">High</option>
                                </select>
                            </div>

                            {/* Amenities */}
                            <div className="mb-3">
                                <label className="form-label report-modal-label">Amenities Available Right Now:</label>
                                <div className="d-flex flex-wrap gap-2">
                                    {[
                                        {id: 1, name: 'Wifi'},
                                        {id: 2, name: 'Printers'},
                                        {id: 3, name: 'Coffee'},
                                        {id: 4, name: 'Bathroom'},
                                        {id: 5, name: 'Whiteboards'},
                                        {id: 6, name: 'Food'},
                                        {id: 7, name: 'Drinks'},
                                        {id: 8, name: 'Seating'},
                                        {id: 9, name: 'Outlets'},
                                        {id: 10, name: 'Windows'},
                                    ].map(amenity => (
                                        <button
                                            key={`report-amenity-${amenity.id}`}
                                            type="button"
                                            className={`btn btn-sm report-amenity-btn ${reportAmenities.includes(amenity.id) ? 'selected' : ''}`}
                                            onClick={() => toggleReportAmenity(amenity.id)}
                                            disabled={!!reportSuccess}
                                        >
                                            {amenity.name}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Comments */}
                            <div className="mb-3">
                                <label className="form-label report-modal-label">Additional Comments:</label>
                                <textarea
                                    className="form-control report-modal-textarea"
                                    placeholder="Anything else others should know..."
                                    rows={3}
                                    value={reportComments}
                                    onChange={e => setReportComments(e.target.value)}
                                    disabled={!!reportSuccess}
                                />
                            </div>

                            {reportError && <div className="alert alert-danger py-2">{reportError}</div>}
                            {reportSuccess && <div className="alert alert-success py-2">{reportSuccess}</div>}

                            <div className="d-flex justify-content-end gap-2">
                                <button className="btn report-btn-skip" onClick={() => setShowReport(false)}>
                                    Skip
                                </button>
                                <button
                                    className="btn report-btn-submit"
                                    onClick={handleReportSubmit}
                                    disabled={!!reportSuccess}
                                >
                                    Submit Report
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
}