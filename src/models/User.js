const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
