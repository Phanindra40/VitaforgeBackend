const { env } = require("../config/env");
const { logger } = require("../utils/logger");

let utapiInstance = null;

// Dynamically import UTApi since uploadthing is an ES module
async function getUTApi() {
  if (!utapiInstance) {
    const token = env.UPLOADTHING_TOKEN;
    if (!token) {
      throw new Error("UPLOADTHING_TOKEN is not configured in environment variables.");
    }
    const { UTApi } = await import("uploadthing/server");
    utapiInstance = new UTApi({ token });
  }
  return utapiInstance;
}

// Retrieve or fallback to Node's File constructor
function getFileClass() {
  if (typeof File !== "undefined") {
    return File;
  }
  try {
    const { File: NodeFile } = require("buffer");
    if (NodeFile) return NodeFile;
  } catch (_err) {
    // Ignore
  }
  throw new Error("Node.js File constructor is not available. Please upgrade Node.js to v18+.");
}

/**
 * Uploads a base64 DataURL to UploadThing and returns the uploaded URL.
 * @param {string} dataUrl - The base64 data URL (e.g. data:image/jpeg;base64,...)
 * @param {string} fileName - The filename to save as
 * @returns {Promise<string>} The uploaded URL
 */
async function uploadBase64(dataUrl, fileName) {
  try {
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      throw new Error("Invalid base64 DataURL format.");
    }
    const mimeType = match[1];
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, "base64");

    const FileConstructor = getFileClass();
    // Create a File object from the buffer
    const file = new FileConstructor([buffer], fileName, { type: mimeType });

    const utapi = await getUTApi();
    const responses = await utapi.uploadFiles([file]);

    if (!responses || responses.length === 0) {
      throw new Error("UploadThing returned an empty response.");
    }

    const response = responses[0];
    if (response.error) {
      throw new Error(`UploadThing error: ${response.error.message}`);
    }

    // ufsUrl is preferred in modern uploadthing SDKs, fallback to url
    const uploadedUrl = response.data?.ufsUrl || response.data?.url;
    if (!uploadedUrl) {
      throw new Error("UploadThing response did not contain an uploaded URL.");
    }

    logger.info(`Successfully uploaded file "${fileName}" to UploadThing. URL: ${uploadedUrl}`);
    return uploadedUrl;
  } catch (error) {
    logger.error(`Failed to upload base64 to UploadThing:`, error);
    throw error;
  }
}

module.exports = {
  uploadBase64,
};
