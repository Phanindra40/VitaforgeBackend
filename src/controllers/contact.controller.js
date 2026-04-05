function invalidInput(res, message) {
  return res.status(400).json({
    error: {
      code: "INVALID_INPUT",
      message,
    },
  });
}

function asTrimmedString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function submitContact(req, res) {
  const name = asTrimmedString(req.body?.name);
  const email = asTrimmedString(req.body?.email);
  const message = asTrimmedString(req.body?.message);
  const source = asTrimmedString(req.body?.source);

  if (!name || name.length > 100) {
    return invalidInput(res, "name is required and must be 1..100 characters");
  }

  if (!email || !isValidEmail(email)) {
    return invalidInput(res, "Invalid email");
  }

  if (!message || message.length > 5000) {
    return invalidInput(res, "message is required and must be 1..5000 characters");
  }

  console.log("[contact] message received", {
    name,
    email,
    source: source || "VitaForge Contact Form",
    receivedAt: new Date().toISOString(),
  });

  return res.status(204).send();
}

module.exports = {
  submitContact,
};
