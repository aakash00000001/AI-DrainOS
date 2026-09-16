// ============================================================
// AI-DrainOS Socket Hub
//
// Tiny shared reference to the single Socket.IO server instance
// created in index.js so routes/services (e.g. vision inspection)
// can emit live events without being passed `io` through every
// call chain. The existing MQTT service keeps receiving `io`
// directly and is untouched.
//
// Outside a running server (e.g. tests) emit() is a safe no-op.
// ============================================================

let ioRef = null;

function init(io) {
  ioRef = io;
}

function emit(event, payload) {
  if (ioRef && typeof ioRef.emit === "function") {
    ioRef.emit(event, payload);
  }
}

module.exports = { init, emit };