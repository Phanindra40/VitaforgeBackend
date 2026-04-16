const multer = require("multer");
const path = require("path");
const fs = require("fs");

const uploadDir = "uploads/";

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "-");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const allowedExtensions = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function fileFilter(_req, file, cb) {
  const extension = path.extname(file.originalname).toLowerCase();

  if (!allowedExtensions.has(extension)) {
    const error = new Error("Only PDF and image files are allowed for OCR");
    error.status = 400;
    return cb(error);
  }

  return cb(null, true);
}

module.exports = multer({
  storage,
  fileFilter,
  limits: { fileSize: 15 * 1024 * 1024 },
});