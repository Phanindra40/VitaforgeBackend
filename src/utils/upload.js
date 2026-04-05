const multer = require("multer");
const path = require("path");

const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "-");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const allowedExtensions = new Set([".pdf", ".doc", ".docx"]);

function fileFilter(_req, file, cb) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    return cb(new Error("Only PDF, DOC, DOCX files are allowed"));
  }
  cb(null, true);
}

module.exports = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});
