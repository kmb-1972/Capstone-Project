import 'bootstrap/dist/css/bootstrap.min.css'
import 'bootstrap/dist/js/bootstrap.bundle.js'
import { useState, useEffect } from 'react';
import { authHeaders, clearUserAmenities, getAmenityTypes } from '../api.js';

const BASE_URL = import.meta.env.VITE_API_URL;


export default function Preferences() {
    const [noiseLevel, setNoiseLevel] = useState(5);
    const [crowdLevel, setCrowdLevel] = useState('');
    const [selectedAmenities, setSelectedAmenities] = useState({});
    const [success, setSuccess] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const [amenityTypes, setAmenityTypes] = useState([]);

    useEffect(() => {
        getAmenityTypes().then(data => {
            setAmenityTypes(Array.isArray(data) ? data : []);
        });
    }, []);


    function toggleAmenity(id) {
        setSelectedAmenities(prev => {
            if (prev[id] !== undefined) {
                const updated = { ...prev };
                delete updated[id];
                return updated;
            }
            return { ...prev, [id]: 1 };
        });
    }

    function setPriority(id, priority) {
        setSelectedAmenities(prev => ({ ...prev, [id]: Number(priority) }));
    }

    async function handleSubmit() {
        setError('');
        setSuccess('');

        if (!crowdLevel) {
            setError('Please select a crowd level.');
            return;
        }
        if (Object.keys(selectedAmenities).length === 0) {
            setError('Please select at least one amenity.');
            return;
        }

        setLoading(true);
        try {

            const prefRes = await fetch(`${BASE_URL}/api/user_preferences`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({
                    noise_level: noiseLevel,
                    crowd_level: crowdLevel,
                })
            });
            const prefData = await prefRes.json();


            if (!prefRes.ok) {
                setError(prefData.error || 'Failed to save preferences.');
                setLoading(false);
                return;
            }
            await clearUserAmenities();

            const amenityPromises = Object.entries(selectedAmenities).map(([amenity_type_id, priority]) =>
                fetch(`${BASE_URL}/api/user_required_amenities`, {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({
                        amenity_type_id: Number(amenity_type_id),
                        priority
                    })
                })
            );

            await Promise.all(amenityPromises);

            setSuccess('Preferences saved successfully!');
        } catch (e) {
            setError('Something went wrong. Please try again.');
        }
        setLoading(false);
    }

    return (
        <div className="container py-4" style={{maxWidth: 700}}>

            {/* page heading */}
            <div className="mb-4">
                <h2 className="fw-bold text-dark text">Location Preferences</h2>
                <p className="text-muted text">Tell us what you need in a location and we'll find the best match for
                    you.</p>
            </div>

            {/* noise level card thingy */}
            <div className="card shadow mb-4 noiseLevelCard">
                <div className="card-body">
                    <h5 className="fw-bold mb-3"> Preferred Noise Level</h5>
                    <label className="form-label">
                        Noise Level: <strong>{noiseLevel}</strong>/10
                    </label>
                    <input
                        type="range"
                        className="form-range"
                        min="1" max="10" step="1"
                        value={noiseLevel}
                        onChange={e => setNoiseLevel(Number(e.target.value))}
                    />
                    <div className="d-flex justify-content-between">
                        <small className="noiseLevelCard">1 — Very Quiet</small>
                        <small className="noiseLevelCard">10 — Very Loud</small>
                    </div>
                </div>
            </div>

            {/* crowd level card*/}
            <div className="card shadow mb-4 crowdLevelCard">
                <div className="card-body">
                    <h5 className="fw-bold mb-3"> Preferred Crowd Level</h5>
                    <select
                        className="form-select  border-secondary crowdLevelCard "
                        value={crowdLevel}
                        onChange={e => setCrowdLevel(e.target.value)}
                    >
                        <option value="" disabled>Select a crowd level</option>
                        <option value="low"> Low — I like it empty</option>
                        <option value="medium">Medium — Some people is fine</option>
                        <option value="high">High — I don't mind busy</option>
                    </select>
                </div>
            </div>

            {/* amenities card — grid of checkboxes */}
            <div className="card border-0 shadow mb-4 crowdLevelCard">
                <div className="card-body">
                    <h5 className="fw-bold mb-1"> Required Amenities</h5>
                    <p className="small mb-3 crowdLevelCard">Select the amenities you need and rate how important each
                        one is.</p>
                    <div className="row g-3">
                        {amenityTypes.map(amenity => {
                            const isSelected = selectedAmenities[amenity.amenity_type_id] !== undefined;
                            return (
                                <div key={amenity.amenity_type_id} className="col-md-6">
                                    <div
                                        className={`card border-0 p-3 ${isSelected ? 'bg-success bg-opacity-25' : 'bg-secondary bg-opacity-25'}`}
                                        style={{cursor: 'pointer'}}
                                    >
                                        <div className="d-flex align-items-center gap-3">
                                            <input
                                                type="checkbox"
                                                className="form-check-input mt-0"
                                                checked={isSelected}
                                                onChange={() => toggleAmenity(amenity.amenity_type_id)}
                                                style={{width: 20, height: 20}}
                                            />
                                            <div className="flex-grow-1">
                                                <div className="fw-bold">{amenity.amenity_name}</div>
                                            </div>
                                        </div>

                                        {isSelected && (
                                            <div className="mt-2">
                                                <label className="form-label small mb-1 ">Priority:</label>
                                                <select
                                                    className="form-select form-select-sm border-secondary crowdLevelCard"
                                                    value={selectedAmenities[amenity.amenity_type_id]}
                                                    onChange={e => setPriority(amenity.amenity_type_id, e.target.value)}
                                                >
                                                    <option value={1}>1 — Nice to have</option>
                                                    <option value={2}>2 — Important</option>
                                                    <option value={3}>3 — Must have</option>
                                                </select>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            {error && <div className="alert alert-danger">{error}</div>}

            {success && <div className="alert alert-success">{success}</div>}
            <button
                className="btn btn-success w-100"
                onClick={handleSubmit}
                disabled={loading}
            >
                {loading ? 'Saving...' : 'Save Preferences'}
            </button>
        </div>
    );
}
