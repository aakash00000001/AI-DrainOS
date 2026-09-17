import { useEffect, useState } from "react";
import { FaClock } from "react-icons/fa";
import { getIncidentTimeline } from "../services/incidentService";
import "../styles/incidents.css";

const EVENT_STYLES = {
  "incident created": "timeline-created",
  "robot assigned": "timeline-robot",
  "route status": "timeline-route",
  acknowledged: "timeline-ack",
  "response started": "timeline-respond",
  resolved: "timeline-resolved"
};

const ROUTE_HINT = {
  PLANNED: "Planned route",
  MANUAL: "Manual assignment",
  NO_ROBOT_AVAILABLE: "No robot available",
  NO_COORDINATES: "No coordinates"
};

function IncidentTimeline({ incidentId }) {

  const [timeline, setTimeline] = useState([]);
  const [loadedId, setLoadedId] = useState(null);

  useEffect(() => {

    if (!incidentId) return undefined;

    let active = true;

    getIncidentTimeline(incidentId)
      .then((data) => {
        if (active) setTimeline(data.timeline || []);
      })
      .catch(() => {
        if (active) setTimeline([]);
      })
      .finally(() => {
        if (active) setLoadedId(incidentId);
      });

    return () => {
      active = false;
    };

  }, [incidentId]);

  if (!incidentId) {
    return (
      <p className="timeline-empty">Select an incident to view its lifecycle events.</p>
    );
  }

  if (loadedId !== incidentId) {
    return <p className="timeline-empty">Loading timeline...</p>;
  }

  if (timeline.length === 0) {
    return <p className="timeline-empty">No lifecycle events recorded yet.</p>;
  }

  return (
    <div className="incident-timeline">

      {timeline.map((event, index) => (
        <div
          key={`${event.event}-${event.at}-${index}`}
          className={`timeline-item ${EVENT_STYLES[event.event] || ""}`}
        >
          <span className="timeline-dot" />
          <div className="timeline-body">
            <p className="timeline-event">{event.event}</p>
            {event.robot && (
              <p className="timeline-meta">🤖 {event.robot}</p>
            )}
            {event.routeStatus && (
              <p className="timeline-meta">{ROUTE_HINT[event.routeStatus] || event.routeStatus}</p>
            )}
            {event.notes && (
              <p className="timeline-notes">{event.notes}</p>
            )}
            <p className="timeline-time">
              <FaClock /> {new Date(event.at).toLocaleString()}
            </p>
          </div>
        </div>
      ))}

    </div>
  );
}

export default IncidentTimeline;