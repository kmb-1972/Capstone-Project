import {useForm} from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import {registerUser, loginUser} from "../api.js";
import {useState} from "react";


export default function SignUp({onLogin}) {
    const navigate = useNavigate();
    const [error, setError] = useState('');
    const {register, handleSubmit, formState: {errors}} = useForm();

    async function onSubmit(data) {
        try {
            const result = await registerUser(data.email, data.password);
            if (result.user) {
                const loginResult = await loginUser(data.email, data.password);
                if (loginResult.accessToken) {
                    onLogin();
                    navigate("/dashboard");
                }
            } else if (result.error) {
                setError(result.error);
            }
        }catch(err) {
            setError("Something went wrong. Please try again!");
        }
    }

    return (
        <div style={{maxWidth: 400, margin: "2rem auto"}}>
            <h2 className="fw-bold mb-3 create-bubble"> Create your account! </h2>
            <div className="card p-4 shadow-sm signUp-card">
                <form onSubmit={handleSubmit(onSubmit)}>
                    <div style={{marginBottom: "1rem"}}>
                        <label>
                            Name:
                            <input type="text" placeholder="Name"
                                   {...register('name', {
                                       required: "Name is required",
                                       minLength: {
                                           value: 1,
                                           message: "Name is required",
                                       },
                                   })}/>
                        </label>
                        {errors.name && (
                            <p style={{color: "crimson"}}>{errors.name.message}</p>
                        )}
                    </div>
                    <div style={{marginBottom: "1rem"}}>
                        <label>
                            Email:
                            <input type="text" placeholder="Email"
                                   {...register('email', {
                                       required: "Email is required",
                                       pattern: {
                                           value: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
                                           message: "please enter a valid email address",
                                       },
                                   })}/>
                        </label>
                        {errors.email && (
                            <p style={{color: "crimson"}}>{errors.email.message}</p>
                        )}
                    </div>
                    <div style={{marginBottom: "1rem"}}>
                        <label>
                            Password:
                            <input type="password" placeholder="********"
                                   {...register('password', {
                                       required: "Passwords are required",
                                       minLength: {
                                           value: 8,
                                           message: "Password must be at least 8 characters",
                                       },
                                       maxLength: {
                                           value: 12,
                                           message: "Password must be at most 12 characters",
                                       },
                                   })}
                            />
                        </label>
                        {errors.password && (
                            <p style={{color: "crimson"}}>{errors.password.message}</p>
                        )}
                    </div>
                    {error && <p style={{color: "crimson"}}>{error}</p>}
                    <button type="submit"> Sign Up</button>
                </form>
            </div>
        </div>
            );
            }