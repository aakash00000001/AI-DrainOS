// ============================================================
// auditMutation.js
//
// Update #27 (Operator Action Audit Trail) - NON-FATAL middleware.
//
// Wraps a protected mutation route and records the operator action
// into the append-only operator_audits trail AFTER the response has
// finished. It is BEST-EFFORT BY DESIGN: any failure in the audit
// hook is logged and swallowed - the real, business mutation must
// never be blocked or slowed down by the audit write.
//
// Usage (per route):
//   auditMutation({
//     action: "DRAIN_UPDATE",
//     entityType: "DRAIN",
//     entityId: (req, resBody) => req.params.id,
//     before: async (req) => currentDrainRow,
//     after:  async (req, resBody) => resBody
//   })
//
//   - `before` captures state BEFORE the mutation (used by updates
//     and deletes); omit for creates.
//   - `entityId` resolves AFTER the response so creates can use the
//     new id from the response body. Defaults to req.params.id.
//   - The recorded payloads are redacted by the service before they
//     are persisted (no secrets ever reach the DB).
// ============================================================

const logger = require("../config/logger");
const operatorAuditService = require("../services/operatorAuditService");

function auditMutation(options = {}) {
  const {
    action,
    entityType,
    entityId = null,
    before = async () => null,
    after = async (req, resBody) => resBody,
    meta = async () => null
  } = options;

  const getEntityId =
    typeof entityId === "function"
      ? entityId
      : () => entityId;

  return async function auditMutationMiddleware(req, res, next) {
    let beforeData = null;
    try {
      beforeData = await before(req);
    } catch (err) {
      logger.warn("[auditMutation] before-hook failed, continuing without it (non-fatal)", {
        message: err.message,
        requestId: req.id,
        action
      });
    }

    let capturedBody = null;
    let patched = false;
    try {
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        capturedBody = body;
        return originalJson(body);
      };
      patched = true;
    } catch (err) {
      logger.warn("[auditMutation] response capture unavailable (non-fatal)", {
        message: err.message,
        requestId: req.id,
        action
      });
    }

    res.on("finish", async () => {
      let afterData = null;
      let metaData = null;
      try {
        afterData = await after(req, capturedBody);
      } catch (err) {
        afterData = null;
        logger.warn("[auditMutation] after-hook failed, continuing without it (non-fatal)", {
          message: err.message,
          requestId: req.id,
          action
        });
      }
      try {
        metaData = await meta(req, capturedBody);
      } catch (err) {
        metaData = null;
        logger.warn("[auditMutation] meta-hook failed, continuing without it (non-fatal)", {
          message: err.message,
          requestId: req.id,
          action
        });
      }

      operatorAuditService.recordAudit({
        requestId: req.id,
        userId: req.user && req.user.id,
        userEmail: req.user && req.user.email,
        method: patched ? req.method : null,
        route: req.originalUrl || req.url || null,
        status: res.statusCode,
        action,
        entityType,
        entityId: getEntityId(req, capturedBody),
        beforeData,
        afterData: afterData !== undefined ? afterData : null,
        metaData: metaData !== null && metaData !== undefined ? metaData : null
      }).catch((err) => {
        logger.warn("[auditMutation] audit record skipped (non-fatal)", {
          message: err.message,
          requestId: req.id,
          action
        });
      });
    });

    return next();
  };
}

module.exports = { auditMutation };