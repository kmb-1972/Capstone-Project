//import {useState} from 'react'
import './App.css'
import 'bootstrap/dist/css/bootstrap.min.css'
import 'bootstrap/dist/js/bootstrap.bundle.js'
import {Routes, Route} from 'react-router-dom';
import {StrictMode, useState} from "react";
import LogIn from "./components/LogIn.jsx";
import SignUp from "./components/SignUp.jsx";
import NavBar from "./components/NavBar.jsx";
import Home from "./components/Home.jsx";
import Locations from "./components/Locations.jsx";
import ChooseOne from "./components/ChooseOne.jsx";
import Dashboard from "./components/Dashboard.jsx";
import Preferences from "./components/Preferences.jsx";
import Settings from "./components/Settings.jsx";


function App() {
    const[isLoggedIn, setIsLoggedIn] = useState(!!(localStorage.getItem("accessToken")));
    return (
        <>
            <NavBar isLoggedIn={isLoggedIn}/>
            <Routes>
                <Route path="/" element={<Home/>}/>
                <Route path="/LogIn" element={<LogIn onLogin={() => setIsLoggedIn(true)}/>}/>
                <Route path="/SignUp" element={<SignUp onLogin={() => setIsLoggedIn(true)}/>}/>
                <Route path="/choose" element={<ChooseOne/>}/>
                <Route path="/dashboard" element={<Dashboard/>}/>
                <Route path="/locations" element={<Locations/>}/>
                <Route path="/preferences" element={<Preferences/>}/>
                <Route path="/settings" element={<Settings />} />
            </Routes>
        </>
    );
}

export default App
