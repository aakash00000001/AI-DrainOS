function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function positiveIntParam(fieldName) {
  return function validatePositiveIntParam(req, res, next) {
    const raw = req.params[fieldName];
    if (raw === undefined) return next();
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      return badRequest(res, `Invalid ${fieldName}: must be a positive integer`);
    }
    req.params[fieldName] = n;
    next();
  };
}

function positiveIntQuery(fieldName) {
  return function validatePositiveIntQuery(req, res, next) {
    const raw = req.query[fieldName];
    if (raw === undefined) return next();
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      return badRequest(res, `Invalid ${fieldName}: must be a positive integer`);
    }
    req.query[fieldName] = n;
    next();
  };
}

function enumQuery(fieldName, allowed, label) {
  return function validateEnumQuery(req, res, next) {
    const raw = req.query[fieldName];
    if (raw === undefined) return next();
    if (!allowed.includes(raw)) {
      return badRequest(res, `Invalid ${label || fieldName}: ${raw}`);
    }
    next();
  };
}

function coordinateParam(fieldName) {
  return function validateCoordinateParam(req, res, next) {
    const raw = req.params[fieldName];
    if (raw === undefined) return next();
    const n = Number(raw);
    if (!Number.isFinite(n) || n < -180 || n > 180) {
      return badRequest(res, `Invalid ${fieldName}: must be a number between -180 and 180`);
    }
    req.params[fieldName] = n;
    next();
  };
}

module.exports = { positiveIntParam, positiveIntQuery, enumQuery, coordinateParam };