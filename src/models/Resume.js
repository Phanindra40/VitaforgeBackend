const mongoose = require("mongoose");

const resumeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
    sourceFileName: { type: String, required: true },
    rawText: { type: String, required: true },
    parsedData: { type: Object, required: true },
    embeddings: [{ type: Number }],
  },
  { timestamps: true }
);

module.exports = mongoose.models.Resume || mongoose.model("Resume", resumeSchema);
