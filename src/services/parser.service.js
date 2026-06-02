const fs = require("fs").promises;
const path = require("path");
const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");

async function extractText(filePath, originalName = "") {
  const extension = path.extname(originalName || filePath).toLowerCase();

  if (extension === ".pdf") {
    if (!PDFParse) throw new Error("pdf-parse module is not available");
    const buffer = await fs.readFile(filePath);
    const uint8 = new Uint8Array(buffer);
    const parser = new PDFParse(uint8);
    const data = await parser.getText();
    return data?.text || "";
  }

  if (extension === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || "";
  }

  if (extension === ".txt") {
    return await fs.readFile(filePath, "utf8");
  }

  if (extension === ".doc") {
    throw new Error(".doc files are not supported. Please upload PDF, DOCX, or TXT.");
  }

  throw new Error("Unsupported file type. Upload PDF, DOCX, or TXT.");
}

module.exports = { extractText };
