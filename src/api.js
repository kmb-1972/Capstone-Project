
const BASE_URL = import.meta.env.VITE_API_URL;
const getAccessToken = () => localStorage.getItem("accessToken");
const getRefreshToken = () => localStorage.getItem("refreshToken");

export function authHeaders () {
    return{"Content-Type": "application/json",
    Authorization: `Bearer ${getAccessToken()}`
};
};

export async function fetchWithRefresh(url, options ={}){
    let response = await fetch(url, options);
    if(response.status === 403) {
        const refreshResponse = await fetch(`${BASE_URL}/api/token`, {
            method: "POST",
            headers:{"Content-Type": "application/json"},
                body: JSON.stringify({token: getRefreshToken()}),
        });
        if(refreshResponse.ok){
            const{accessToken} = await refreshResponse.json();
            localStorage.setItem("accessToken", accessToken);
            options.headers.Authorization = `Bearer ${accessToken}`;
            response = await fetch(url, options);
    }else{
            localStorage.clear();
            window.location.href = "/";
        }
    }
    return response.json();
};

export const registerUser = async (email, password) =>{
    const response = await fetch(`${BASE_URL}/api/register`, {
        method: "POST",
        headers:{"Content-Type": "application/json"},
        body: JSON.stringify({email, password})
    });
    return response.json();
};
export const loginUser = async (email, password) =>{
    const response = await fetch(`${BASE_URL}/api/login`, {
        method: "POST",
        headers:{"Content-Type": "application/json"},
        body: JSON.stringify({email, password})
    });
    const data = await response.json();
    if(data.accessToken){
        localStorage.setItem("accessToken", data.accessToken);
        localStorage.setItem("refreshToken", data.refreshToken);
    }return data;
};
export const getLocationStates = () =>
    fetch(`${BASE_URL}/api/location_states`).then(r => r.json());
export const getCheckinStatus = () =>
    fetchWithRefresh(`${BASE_URL}/api/checkin/status`, {
        method: "GET",
        headers: authHeaders()
    });
export const getLocations = () =>
    fetch(`${BASE_URL}/api/locations`).then(r => r.json());

export const getLocationById = (id) =>
    fetch(`${BASE_URL}/api/locations/${id}`).then(r => r.json());

export const searchLocations = (noise_preference, amenities = []) =>
    fetch(`${BASE_URL}/api/locations/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noise_preference, amenities })
    }).then(r => r.json());

export const getAmenityTypes = () =>
    fetch(`${BASE_URL}/api/amenity_types`).then(r => r.json());

export const getAmenitiesByLocation = (id) =>
    fetch(`${BASE_URL}/api/amenities/${id}`).then(r => r.json());

export const submitReport = (reportData) =>
    fetchWithRefresh(`${BASE_URL}/api/reports`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(reportData)
    });

export const checkIn = (location_id) =>
    fetchWithRefresh(`${BASE_URL}/api/checkin`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ location_id })
    });

export const checkOut = () =>
    fetchWithRefresh(`${BASE_URL}/api/checkout`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({})
    });

export const getCheckinHistory = () =>
    fetchWithRefresh(`${BASE_URL}/api/checkin/history`, {
        method: "GET",
        headers: authHeaders()
    });

export const logoutUser = async () => {
    await fetch(`${BASE_URL}/api/logout`, {
        method: "DELETE",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({token: getRefreshToken()})
    });
    localStorage.clear();
};
    export const getUserPreferences=() =>
    fetchWithRefresh(`${BASE_URL}/api/user_preferences/me`, {
        method: 'GET',
        headers: authHeaders()
    });

    export const getUserRequiredAmenities = () =>
        fetchWithRefresh(`${BASE_URL}/api/user_required_amenities/me`, {
            method: 'GET',
            headers: authHeaders()
        });
export const clearUserAmenities = () =>
    fetchWithRefresh(`${BASE_URL}/api/user_required_amenities/me`, {
        method: 'DELETE',
        headers: authHeaders()
    });
export const getLocationStateById = (id) =>
    fetch(`${BASE_URL}/api/location_states/${id}`).then(r => r.json());

