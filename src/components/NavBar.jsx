import { NavLink } from "react-router-dom";
import logo from    "../assets/null.svg"
import world from "../assets/world.png";


export default function NavBar({isLoggedIn}) {
    return (
    <nav className="navbar navbar-expand-lg nav-color" data-bs-theme="dark">
        <div className="container-fluid">
        <span className="navbar-brand">
            <img src={world} alt="Full or Null" style={{ width: "30px", height: "30px", objectFit: "contain" }}/> Full Or Null

        </span>
            <button className="navbar-toggler" type="button" data-bs-toggle="collapse"
                    data-bs-target="#navbarSupportedContent" aria-controls="navbarSupportedContent"
                    aria-expanded="false" aria-label="Toggle navigation">
                    <span className="navbar-toggler-icon"></span>
                </button>
                <div className="collapse navbar-collapse" id="navbarSupportedContent">
                    <ul className="navbar-nav ms-auto mb-2 mb-lg-0 gap-2">
                        {!isLoggedIn ? (
                            <>
                        <li className="nav-item">
                            <NavLink
                                to="/"
                                end
                                className={({isActive}) =>
                                    'nav-link' + (isActive ? ' active' : '')}
                            >Home</NavLink>
                        </li>

                        <li className="nav-item">
                            <NavLink
                                to="/LogIn"
                                end
                                className={({isActive}) =>
                                    'nav-link' + (isActive ? ' active' : '')}
                            >Log in</NavLink>
                        </li>
                        <li className="nav-item">
                            <NavLink
                                to="/SignUp"
                                end
                                className={({isActive}) =>
                                    'nav-link' + (isActive ? ' active' : '')}
                            > Sign Up</NavLink>
                    </li>
                            </>
                            ):(
                                <>
                                <li className="nav-item">
                                    <NavLink to="/dashboard" className="nav-link">Dashboard</NavLink>
                                </li>
                                <li className="nav-item">
                                    <NavLink to="/locations" className="nav-link">Locations</NavLink>
                                </li>
                                <li className="nav-item">
                                    <NavLink to="/settings" className="nav-link">Settings</NavLink>
                                </li>
                                </>
                        )}
                </ul>
        </div>
    </div>
</nav>

)
}