const { logger } = require("../utils/logger");

function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "Not Found",
      details: {
        path: req.originalUrl,
      },
    },
  });
}

function errorHandler(error, _req, res, _next) {
  const status =
    error.status ||
    error.statusCode ||
    (error.name === "MulterError" ? 400 : 500);

  logger.error("Request failed", error);
  res.status(status).json({
    error: {
      code: error.code || (status === 500 ? "INTERNAL_SERVER_ERROR" : "ERROR"),
      message: error.message || "Internal Server Error",
      details: error.details || undefined,
    },
  });
}

module.exports = { notFoundHandler, errorHandler };
