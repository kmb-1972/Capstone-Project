import NavBar from "./NavBar.jsx";
import 'bootstrap/dist/css/bootstrap.min.css'
import 'bootstrap/dist/js/bootstrap.bundle.js'
import {useNavigate} from "react-router-dom";



function Home() {
    const navigate = useNavigate();
    const features = [
        {
            icon: "⏱️",
            title: "Focus Timer",
            description: "Check in to any location and we automatically track how long you've been there. So you can stay in the zone without watching the clock.",
            accent: "#4f8ef7",
        },
        {
            icon: "📊",
            title: "Focus Stats",
            description: "See which locations you visit most and how long you stay. Discover your most productive spots with easy-to-read insights.",
            accent: "#a78bfa",
        },
        {
            icon: "✨",
            title: "Built Around You",
            description: "Your preferences shape everything. We surface spaces that match your vibe: quiet, social, caffeinated, or anywhere in between.",
            accent: "#34d399",
        },
    ];

    return (
        <>
                <div className="homeBackground d-flex align-items-center justify-content-center text-center">
                    <div className="home-Content d-flex flex-column align-items-center justify-content-center">
                        <h1 className="display-4 fw-bold bubble ">
                             Find your <i>perfect </i> spot
                        </h1>
                        <p className="fs-5 col-md-8 mx-auto home-text">
                            Explore different locations based
                            on your own preferences! Give reports on areas for others to know! And discover the best
                            places
                            to focus!
                        </p>
                        <p className="mt-4 fs-5">
                            Find your space. Focus better.
                        </p>
                        <button className="btn btn-light btn-lg mt-3 px-5"
                                onClick={() => {
                                    navigate("/choose")
                                }}
                        >Join today!
                        </button>

                    </div>
                </div>

            {/* Feature Cards Section */}
            <section className="features-section py-5">
                <div className="container py-4">
                    <h2 className="features-heading text-center mb-2">Why it works</h2>
                    <p className="features-subheading text-center mb-5">
                        Everything you need to find focus, effortlessly.
                    </p>

                    <div className="row g-4 justify-content-center">
                        {features.map((f, i) => (
                            <div className="col-12 col-md-4" key={i}>
                                <div className="feature-card h-100">
                                    <div
                                        className="feature-icon-wrap"
                                        style={{ "--accent": f.accent }}
                                    >
                                        <span className="feature-icon">{f.icon}</span>
                                    </div>
                                    <h3 className="feature-title">{f.title}</h3>
                                    <p className="feature-desc">{f.description}</p>
                                    <div
                                        className="feature-bar"
                                        style={{ background: f.accent }}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>
            {/* Footer */}
            <footer className="py-4 text-center" style={{backgroundColor: '#6b8f71', color: 'white'}}>
                <div className="container">
                    <p className="mb-1 fw-bold fs-5">Full or Null</p>
                    <p className="mb-2 small" style={{color: 'rgba(255,255,255,0.8)'}}>
                        A smart location finder that helps you find the perfect spot based on real-time crowd and noise data.
                    </p>
                    <hr style={{borderColor: 'rgba(255,255,255,0.3)'}}/>
                    <p className="mb-0 small" style={{color: 'rgba(255,255,255,0.8)'}}>
                        Creators: Erik Terrazas · Coral M. Cortes · Nicholas Gossmeyer
                    </p>
                    <p className="mb-0 small mt-1" style={{color: 'rgba(255,255,255,0.6)'}}>
                        Capstone Project · Aurora University · 2026
                    </p>
                </div>
            </footer>
        </>
    );
}

export default Home;

