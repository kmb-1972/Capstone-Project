import {useNavigate} from "react-router-dom";


export default function ChooseOne() {
    const navigate = useNavigate();
    return (
        <div className=" chooseOne d-flex align-items-center justify-content-center" style={{minHeight:'100vh'}}>
            <div className="text-center">
                <h2 className="fw-bold mb-2">Welcome!</h2>
                <div className="d-flex gap-3 justify-content-center">
                    <button className="btn btn-outline-dark btn-lg px-5" onClick={() => navigate('/LogIn')}>Log in</button>
                    <button className="btn btn-outline-dark btn-lg px-5" onClick={() => navigate('/SignUp')}>Sign up
                    </button>
                </div>
            </div>
        </div>
    );
}