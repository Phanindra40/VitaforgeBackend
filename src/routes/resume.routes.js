const express = require("express");

const upload = require("../utils/upload");
const controller = require("../controllers/resume.controller");

const router = express.Router();

router.post("/upload", upload.single("resume"), controller.uploadResume);
router.post("/match", controller.matchResumeToJob);
router.post("/ats", controller.calculateAtsScore);
router.post("/semantic-match", controller.semanticMatch);
router.post("/improve", controller.improveResume);
router.post("/recommend", controller.recommendJobs);

router.get("/", controller.getAllResumes);
router.post("/", controller.createNewResume);
router.get("/:id", controller.getResume);
router.patch("/:id", controller.patchResume);
router.put("/:id", controller.putResume);
router.delete("/:id", controller.removeResume);
router.post("/:id/duplicate", controller.duplicateResume);

module.exports = router;
