import { useState } from "react";
import axios from "axios";
import { API_URL, authHeaders } from "../services/api";

function EditDrainForm({ drain, onUpdated, onClose }) {

  const [form, setForm] = useState({
    zone_name: drain.zone_name,
    location: drain.location,
    status: drain.status,
    blockage_level: drain.blockage_level,
    latitude: drain.latitude,
    longitude: drain.longitude
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

      await axios.put(
        `${API_URL}/drains/${drain.id}`,
        {
          ...form,
          blockage_level: Number(form.blockage_level),
          latitude: Number(form.latitude),
          longitude: Number(form.longitude)
        },
        { headers: authHeaders() }
      );

      alert("✅ Drain Updated Successfully");

      onUpdated();

      onClose();

    } catch (error) {

      console.log(error);

      alert("❌ Update Failed");

    }

  };

  return (

    <div className="panel">

      <h2>✏️ Edit Drain</h2>

      <form onSubmit={handleSubmit}>

        <input
          type="text"
          name="zone_name"
          value={form.zone_name}
          onChange={handleChange}
        />

        <br /><br />

        <input
          type="text"
          name="location"
          value={form.location}
          onChange={handleChange}
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
          value={form.blockage_level}
          onChange={handleChange}
        />

        <br /><br />

        <input
          type="number"
          step="any"
          name="latitude"
          placeholder="Latitude"
          value={form.latitude ?? ""}
          onChange={handleChange}
        />

        <br /><br />

        <input
          type="number"
          step="any"
          name="longitude"
          placeholder="Longitude"
          value={form.longitude ?? ""}
          onChange={handleChange}
        />

        <br /><br />

        <button type="submit">
          Update Drain
        </button>

        <button
          type="button"
          onClick={onClose}
          style={{
            marginLeft: "10px"
          }}
        >
          Cancel
        </button>

      </form>

    </div>

  );
}
export default EditDrainForm;