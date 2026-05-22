const fs = require("fs");
const path = require("path");
const _pdf = require("pdf-parse");
const pdf = typeof _pdf === "function" ? _pdf : (_pdf && _pdf.default) ? _pdf.default : null;
const mammoth = require("mammoth");

async function extractText(filePath, originalName = "") {
  const extension = path.extname(originalName || filePath).toLowerCase();

  if (extension === ".pdf") {
    if (!pdf) throw new Error("pdf-parse module is not available");
    const buffer = fs.readFileSync(filePath);
    const data = await pdf(buffer);
    return data?.text || "";
  }

  if (extension === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || "";
  }

  if (extension === ".txt") {
    return fs.readFileSync(filePath, "utf8");
  }

  if (extension === ".doc") {
    throw new Error(".doc files are not supported. Please upload PDF, DOCX, or TXT.");
  }

  throw new Error("Unsupported file type. Upload PDF, DOCX, or TXT.");
}

module.exports = { extractText };
