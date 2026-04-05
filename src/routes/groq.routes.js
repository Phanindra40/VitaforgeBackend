const express = require("express");

const controller = require("../controllers/groq.controller");

const router = express.Router();

router.post("/generate", controller.generate);
router.post("/summary-from-jd", controller.summaryFromJd);

module.exports = router;
