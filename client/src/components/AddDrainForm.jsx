import { useState } from "react";
import axios from "axios";
import { API_URL, authHeaders } from "../services/api";

function AddDrainForm({ onDrainAdded }) {
  const [form, setForm] = useState({
    zone_name: "",
    location: "",
    status: "Normal",
    blockage_level: "",
    latitude: "",
    longitude: ""
  });

  const handleChange = (e) => {
    setForm({
      ...form,
      [e.target.name]: e.target.value
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    try {
      await axios.post(
        `${API_URL}/drains`,
        {
          ...form,
          blockage_level: Number(form.blockage_level),
          latitude: Number(form.latitude),
          longitude: Number(form.longitude)
        },
        { headers: authHeaders() }
      );

      alert("✅ Drain Added Successfully");

      setForm({
        zone_name: "",
        location: "",
        status: "Normal",
        blockage_level: "",
        latitude: "",
        longitude: ""
      });

      onDrainAdded();

    } catch (err) {
      console.log(err);
      alert("❌ Failed to Add Drain");
    }
  };

  return (
    <div className="panel">
      <h2>➕ Add New Drain</h2>

      <form onSubmit={handleSubmit}>

        <input
          type="text"
          name="zone_name"
          placeholder="Zone Name"
          value={form.zone_name}
          onChange={handleChange}
          required
        />

        <br /><br />

        <input
          type="text"
          name="location"
          placeholder="Location"
          value={form.location}
          onChange={handleChange}
          required
        />

        <br /><br />

        <select
          name="status"
          value={form.status}
          onChange={handleChange}
        >
          <option>Normal</option>
          <option>Warning</option>
          <option>Critical</option>
        </select>

        <br /><br />

        <input
          type="number"
          name="blockage_level"
          placeholder="Blockage %"
          value={form.blockage_level}
          onChange={handleChange}
          required
        />

        <br /><br />

        <input
          type="number"
          step="any"
          name="latitude"
          placeholder="Latitude (e.g. 9.9252)"
          value={form.latitude}
          onChange={handleChange}
        />

        <br /><br />

        <input
          type="number"
          step="any"
          name="longitude"
          placeholder="Longitude (e.g. 78.1198)"
          value={form.longitude}
          onChange={handleChange}
        />

        <br /><br />

        <button type="submit">
          Add Drain
        </button>

      </form>
    </div>
  );
}

export default AddDrainForm;