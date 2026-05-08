import 'bootstrap/dist/css/bootstrap.min.css'
import 'bootstrap/dist/js/bootstrap.bundle.js'
import {useNavigate} from "react-router-dom";
import{useState, useEffect} from "react";
import {getLocations, getCheckinStatus,getLocationStates} from "../api.js";


function getCrowdBadge(crowd_level){
    if(crowd_level === 'low') return 'badge bg-success';
    if(crowd_level === 'medium') return 'badge bg-warning text-dark';
    return 'badge bg-danger';
}
function getNoiseBadge(noise_level){
    if(noise_level <=3.5)return{label: 'Quiet', color: 'badge bg-success'};
    if(noise_level <= 6 && noise_level > 3.5 )return{label: 'Moderate', color: 'badge bg-warning text-dark'};
    return {label: 'Loud', color:'badge bg-danger'};
}

export default function Dashboard() {
    const navigate = useNavigate();
    const [search, setSearch] = useState('');
    const [showDropdown, setShowDropdown] = useState(false);
    const userName = localStorage.getItem('userName') || 'there';
    const [locations, setLocations] = useState([]);
    const [locationStates, setLocationStates] = useState([]);
    const[setCheckinStatus] = useState(null);
    const[loading, setLoading] = useState(true);


    useEffect(() => {
        async function loadData(){
            try{
                const [locationData, states, status] = await Promise.all([getLocations(),getLocationStates(), getCheckinStatus()]);
                setLocations(Array.isArray(locationData) ? locationData : []);
                setLocationStates(Array.isArray(states) ? states : []);
                setCheckinStatus(status);
            }catch(error){
                console.error("failed to load dashboard data:", error);
            }finally{
                setLoading(false);
            }
        }
        loadData();
    }, []);


    const uniqueStates = locationStates.reduce((acc, state) => {
        const existing = acc.find(s => s.location_id === state.location_id);
        if (!existing) return [...acc, state];


        // prefer current time window, fall back to most recently updated
        const currentHour = new Date().getHours();
        const currentWindow = currentHour >= 17 ? 'Evening' : currentHour >= 12 ? 'Afternoon' : currentHour >= 5 ? 'Morning' : 'night';

        if (state.time_window === currentWindow) return [...acc.filter(s => s.location_id !== state.location_id), state];
        return acc;
    }, []);


    const busyLocations = uniqueStates.filter(l =>
        l.avg_crowd_level === 'high' || parseFloat(l.avg_noise_level) >= 7
    );
    const quietLocations = uniqueStates.filter(l =>
        parseFloat(l.avg_noise_level) <= 3.5 && l.avg_crowd_level !== 'high'
    );


    const filteredLocations = locations.filter(loc => loc.name.toLowerCase().includes(search.toLowerCase()));

    function handleSearchSelect(location) {
        setSearch(location.name);
        setShowDropdown(false);
        navigate('/locations')
    }

    function handleSearchSubmit(e) {
        e.preventDefault();
        navigate('/locations');
    }

    if (loading) return <p className="text-center mt-5">Loading...</p>;
    return (
        <>
            <div className="container py-4">

                <div className="mb-4">
                    <h2 className="fw-bold dashBoard-hi "> Hi, {userName}</h2>
                    <p className=" nearYou"> Here is what is happening at reported locations! </p>
                </div>

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
                                    onMouseDown={() => handleSearchSelect(loc)}
                                >
                                    {loc.name}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>


                {/* Stat Cards */}
                <div className="row g-3 mb-4">
                    <div className="col-md-4">
                        <div className="card text-center p-3 border-0 shadow firstCard">

                            <h3 className="fw-bold">{busyLocations.length}</h3>
                            <p className="mb-1">Locations Busy Right Now</p>
                            <small className=" firstCardText">
                                {busyLocations.map(l => {
                                    const loc = locations.find(loc => loc.location_id === l.location_id);
                                    return loc ? loc.name : l.location_id;
                                }).join(' . ') || 'None right now'}</small>
                        </div>
                    </div>
                    <div className="col-md-4">
                        <div className="card text-center p-3 border-0 shadow firstCard">

                            <h3 className="fw-bold">{quietLocations.length}</h3>
                            <p className="mb-1">Quiet Spots Available</p>
                            <small className="firstCardText">{
                                quietLocations.map(l => {
                                    const loc = locations.find(loc => loc.location_id === l.location_id);
                                    return loc ? loc.name : l.location_id;
                                }).join(' · ') || 'None right now'}</small>
                        </div>
                    </div>
                </div>

                {/* Recently Reported */}
                <div className="card bg-dark text-white border-0 shadow">
                    <div className="card-body locationReportedCard">
                        <h5 className="card-title fw-bold mb-3"> Recently Reported Locations</h5>
                        <ul className="list-group list-group-flush ">
                            {locationStates.map(state => {
                                const locName = locations.find(l => l.location_id === state.location_id);
                                const noise = getNoiseBadge(parseFloat(state.avg_noise_level));
                                return (
                                    <li key={state.location_id}
                                        className="list-group-item d-flex justify-content-between align-items-center locationGroup "
                                        onClick={() => navigate('/locations')}
                                        style={{cursor: 'pointer'}}
                                    >
                                        <div>
                                            <span className="fw-bold reportName "> {
                                                locName ? locName.name : state.location_id}</span>
                                            <small className="ms-2 locationText">{state.time_window}</small>
                                        </div>
                                        <div className="d-flex gap-2">
                                            <span className={noise.color}>{noise.label}</span>
                                            <span
                                                className={getCrowdBadge(state.avg_crowd_level)}>{state.avg_crowd_level} crowd</span>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                </div>
            </div>
        </>
    );
}


