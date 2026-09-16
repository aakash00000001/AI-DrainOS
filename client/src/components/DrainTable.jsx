import { useState } from "react";
import axios from "axios";
import {
  FaSearch,
  FaTrash,
  FaMapMarkerAlt,
  FaFlag
} from "react-icons/fa";
import { API_URL, authHeaders } from "../services/api";

const headers = authHeaders();

function DrainTable({ drains, onRefresh }) {

  const [search, setSearch] = useState("");

  const deleteDrain = (id) => {

    if (!window.confirm("Delete this drain?")) return;

    axios
      .delete(`${API_URL}/drains/${id}`, { headers })
      .then(() => {

        onRefresh();

      })
      .catch((err) => {

        console.log(err);

      });

  };

  const flagDrain = (id, status) => {

    axios
      .patch(`${API_URL}/drains/${id}/status`, { status }, { headers })
      .then(() => {

        onRefresh();

      })
      .catch((err) => {

        console.log(err);

        alert(err.response?.data?.error || "Failed to update status");

      });

  };

  const filtered = drains.filter((drain) =>

    drain.zone_name
      ?.toLowerCase()
      .includes(search.toLowerCase()) ||

    drain.location
      ?.toLowerCase()
      .includes(search.toLowerCase())

  );

  return (

    <div className="table-card">

      <div className="table-header">

        <h2>📋 Drain Management</h2>

        <div className="search-box">

          <FaSearch />

          <input

            type="text"

            placeholder="Search Zone..."

            value={search}

            onChange={(e)=>setSearch(e.target.value)}

          />

        </div>

      </div>

      <table>

        <thead>

          <tr>

            <th>Zone</th>

            <th>Location</th>

            <th>Water</th>

            <th>Status</th>

            <th>Action</th>

          </tr>

        </thead>

        <tbody>

          {

            filtered.map((drain)=>(

              <tr key={drain.id}>

                <td>{drain.zone_name}</td>

                <td>

                  <FaMapMarkerAlt />

                  {" "}

                  {drain.location}

                </td>

                <td>{drain.water_level}%</td>

                <td>

                  <span

                    className={

                      drain.status==="Critical"

                      ?"status-critical"

                      :drain.status==="Warning"

                      ?"status-warning"

                      :"status-normal"

                    }

                  >

                    {drain.status}

                  </span>

                </td>

                <td>

                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>

                    <button
                      className="action-btn"
                      style={{
                        background: drain.status === "Critical" ? "#ef4444" : "transparent",
                        color: drain.status === "Critical" ? "#fff" : "#ef4444"
                      }}
                      title="Flag as Critical"
                      onClick={() => flagDrain(drain.id, "Critical")}
                    >
                      <FaFlag /> Critical
                    </button>

                    <button
                      className="action-btn"
                      style={{
                        background: drain.status === "Warning" ? "#d97706" : "transparent",
                        color: drain.status === "Warning" ? "#fff" : "#d97706"
                      }}
                      title="Flag as Warning"
                      onClick={() => flagDrain(drain.id, "Warning")}
                    >
                      Warning
                    </button>

                    <button
                      className="action-btn"
                      style={{
                        background: drain.status === "Normal" ? "#16a34a" : "transparent",
                        color: drain.status === "Normal" ? "#fff" : "#16a34a"
                      }}
                      title="Mark as Normal"
                      onClick={() => flagDrain(drain.id, "Normal")}
                    >
                      Normal
                    </button>

                    <button

                      className="delete-btn"

                      onClick={()=>deleteDrain(drain.id)}

                    >

                      <FaTrash />

                    </button>

                  </div>

                </td>

              </tr>

            ))

          }

        </tbody>

      </table>

    </div>

  );

}

export default DrainTable;