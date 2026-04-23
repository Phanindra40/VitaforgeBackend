const mongoose = require("mongoose");

const resumeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
    sourceFileName: { type: String, required: false },
    rawText: { type: String, required: false },
    parsedData: { type: Object, required: false },
    embeddings: [{ type: Number }],
    
    // Frontend resume builder fields
    name: { type: String, required: false },
    template: { type: String, required: false },
    spacingMode: { type: String, required: false },
    personalInfo: { type: Object, required: false },
    summary: { type: String, required: false },
    experiences: [{ type: Object }],
    projects: [{ type: Object }],
    education: [{ type: Object }],
    skills: [{ type: Object }],
    sectionTitles: { type: Object, required: false },
    
    // Legacy/other fields
    title: { type: String, required: false },
    role: { type: String, required: false },
    contact: { type: Object, required: false },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Resume || mongoose.model("Resume", resumeSchema);
