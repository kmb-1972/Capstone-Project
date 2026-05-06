import 'bootstrap/dist/css/bootstrap.min.css'
import 'bootstrap/dist/js/bootstrap.bundle.js'
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { logoutUser, getCheckinHistory } from '../api.js';

export default function Settings({ onLogout }) {

    const navigate = useNavigate();
    const [showStats, setShowStats] = useState(false);
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const userEmail = localStorage.getItem('userEmail') || 'your account';

    async function handleShowStats() {
        setShowStats(true);
        setLoading(true);
        try {
            const result = await getCheckinHistory();
            setHistory(result.history || []);
        } catch (e) {
            setError('Failed to load stats. Please try again.');
        }
        setLoading(false);
    }

    async function handleSignOut() {
        await logoutUser();
        if (onLogout) onLogout();
        navigate('/');
    }

    function checkInsThisWeek() {
        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
        return history.filter(h => new Date(h.check_in_time) > oneWeekAgo).length;
    }

    function totalMinutesStudied() {
        return history.reduce((sum, h) => sum + (parseInt(h.duration_minutes) || 0), 0);
    }

    function favoriteLocation() {
        if (history.length === 0) return 'N/A';
        const counts = {};
        history.forEach(h => {
            counts[h.location_name] = (counts[h.location_name] || 0) + 1;
        });
        return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    }

    function formatDuration(mins) {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        if (h === 0) return `${m}m`;
        if (m === 0) return `${h}h`;
        return `${h}h ${m}m`;
    }

    function formatDate(dateStr) {
        return new Date(dateStr).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });
    }

    return (
        <div className="container py-4" style={{ maxWidth: 700 }}>

            {/* page heading */}
            <div className="mb-4">
                <h2 className="fw-bold text-dark">Settings</h2>
                <p className="text-muted">Manage your account and preferences.</p>
            </div>

            {/* preferences shortcut card */}
            <div className="card mb-4 preferencesCard">
                <div className="card-body">
                    <h5 className="fw-bold mb-1"> Preferences</h5>
                    <p className="text-muted small mb-3">Update your noise, crowd and amenity preferences to get better location recommendations.</p>
                    <button className="btn searchButton" onClick={() => navigate('/preferences')}>
                        Update Preferences
                    </button>
                </div>
            </div>

            {/* stats card */}
            <div className="card mb-4 preferencesCard">
                <div className="card-body">
                    <h5 className="fw-bold mb-1"> Your Focus Stats</h5>
                    <p className="text-muted small mb-3">See how often you've been locked in and where!</p>

                    {/* button to load stats */}
                    {!showStats && (
                        <button className="btn searchButton" onClick={handleShowStats}>
                            Check Your Stats
                        </button>
                    )}
                    {showStats && loading && (
                        <p className="text-muted">Loading your stats...</p>
                    )}
                    {error && <div className="alert alert-danger">{error}</div>}
                    {showStats && !loading && history.length > 0 && (
                        <>
                            <div className="row g-3 mb-4">
                                <div className="col-6 col-md-3">
                                    <div className="card text-center p-2 firstCard">
                                        <div className="fw-bold fs-5">{checkInsThisWeek()}</div>
                                        <small>Check-ins this week</small>
                                    </div>
                                </div>
                                <div className="col-6 col-md-3">
                                    <div className="card text-center p-2 firstCard">
                                        <div className="fw-bold fs-5">{formatDuration(totalMinutesStudied())}</div>
                                        <small>Total time locked in</small>
                                    </div>
                                </div>

                                <div className="col-6 col-md-3">
                                    <div className="card text-center p-2 firstCard">
                                        <div className="fw-bold fs-5" style={{fontSize: '0.85rem'}}>{favoriteLocation()}</div>
                                        <small> 📌 Favorite spot</small>
                                    </div>
                                </div>
                            </div>
                            <h6 className="fw-bold mb-2">Recent Check-ins</h6>
                            <ul className="list-group list-group-flush">
                                {history.slice(0, 10).map((h, i) => (
                                    <li key={i} className="list-group-item locationGroup d-flex justify-content-between align-items-center">
                                        <div>
                                            <span className="fw-bold">📍 {h.location_name}</span>
                                            <small className="text-muted ms-2">{formatDate(h.check_in_time)}</small>
                                        </div>
                                        <span className="badge bg-secondary">
                                            {h.duration_minutes ? formatDuration(parseInt(h.duration_minutes)) : 'In progress'}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                            {history.length > 10 && (
                                <p className="text-muted small mt-2 text-center">
                                    Showing 10 of {history.length} check-ins
                                </p>
                            )}
                        </>
                    )}
                    {showStats && !loading && history.length === 0 && (
                        <p className="text-muted small">No check-in history yet — start exploring study spots!</p>
                    )}
                </div>
            </div>
            <div className="card mb-4 preferencesCard">
                <div className="card-body">
                    <h5 className="fw-bold mb-1"> Sign Out</h5>
                    <p className="text-muted small mb-3">You'll need to log back in to access your account.</p>
                    <button className="btn btn-danger" onClick={handleSignOut}>
                        Sign Out
                    </button>
                </div>
            </div>

        </div>
    );
}
