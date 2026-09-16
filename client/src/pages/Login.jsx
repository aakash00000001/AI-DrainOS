import { useState } from "react";
import axios from "axios";
import "./Login.css";

const API_URL =
  import.meta.env.VITE_API_URL || "http://localhost:5000/api";

function Login({ setLogin }) {

  const [email, setEmail] = useState("");

  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);

  const [error, setError] = useState("");

  const handleLogin = async () => {

    setLoading(true);

    setError("");

    try {

      const response = await axios.post(

        `${API_URL}/auth/login`,

        {

          email,

          password

        }

      );

      localStorage.setItem(

        "token",

        response.data.token

      );

      localStorage.setItem(

        "user",

        JSON.stringify(response.data.user)

      );

      setLogin(true);

    }

    catch (err) {

      if (err.response) {

        setError(err.response.data.message);

      }

      else {

        setError("Server Not Reachable");

      }

    }

    finally {

      setLoading(false);

    }

  };

  return (

    <div className="login-page">

      <div className="login-card">

        <h1>

          🚧 AI-DrainOS

        </h1>

        <p>

          Smart Drainage Command Center

        </p>

        <input

          type="email"

          placeholder="Email"

          value={email}

          onChange={(e)=>setEmail(e.target.value)}

        />

        <input

          type="password"

          placeholder="Password"

          value={password}

          onChange={(e)=>setPassword(e.target.value)}

        />

        {

          error &&

          <p className="login-error">

            {error}

          </p>

        }

        <button

          onClick={handleLogin}

          disabled={loading}

        >

          {

            loading

            ?

            "Logging in..."

            :

            "Login"

          }

        </button>

        <span>

          Authorized Officer Access Only

        </span>

      </div>

    </div>

  );

}

export default Login;