function notFoundHandler(req, res) {
  res.status(404).json({
    error: "Not Found",
    path: req.originalUrl,
  });
}

function errorHandler(error, _req, res, _next) {
  const status = error.status || 500;
  console.error("Error:", error.message, error.stack);
  res.status(status).json({
    error: error.message || "Internal Server Error",
  });
}

module.exports = { notFoundHandler, errorHandler };
