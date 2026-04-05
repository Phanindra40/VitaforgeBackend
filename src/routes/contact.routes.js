const express = require("express");

const controller = require("../controllers/contact.controller");

const router = express.Router();

router.post("/", controller.submitContact);

module.exports = router;
