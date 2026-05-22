const { env } = require("../config/env");

function normalizeContext(context) {
  if (context === undefined || context === null) {
    return "";
  }

  if (context instanceof Error) {
    return JSON.stringify({
      name: context.name,
      message: context.message,
      status: context.status,
      code: context.code,
    });
  }

  if (typeof context === "string") {
    return context;
  }

  try {
    return JSON.stringify(context);
  } catch (_error) {
    return String(context);
  }
}

function write(level, message, context) {
  const timestamp = new Date().toISOString();
  const suffix = normalizeContext(context);
  const line = suffix ? `${timestamp} ${level.toUpperCase()} ${message} ${suffix}` : `${timestamp} ${level.toUpperCase()} ${message}`;

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  if (level === "debug" && env.NODE_ENV === "production") {
    return;
  }

  console.log(line);
}

const logger = {
  info(message, context) {
    write("info", message, context);
  },
  warn(message, context) {
    write("warn", message, context);
  },
  error(message, context) {
    write("error", message, context);
  },
  debug(message, context) {
    write("debug", message, context);
  },
};

module.exports = { logger };
