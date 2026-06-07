const express = require("express");
const { savePortfolio, getPortfolio } = require("../controllers/portfolio.controller");

const router = express.Router();

router.post("/", savePortfolio);
router.get("/:id", getPortfolio);

module.exports = router;
