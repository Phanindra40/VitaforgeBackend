const mongoose = require("mongoose");

const jobSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, index: true },
    description: { type: String, required: true },
    embeddings: [{ type: Number }],
  },
  { timestamps: true }
);

module.exports = mongoose.models.Job || mongoose.model("Job", jobSchema);
