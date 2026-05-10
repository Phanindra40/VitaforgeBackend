const crypto = require("crypto");
const { createClient } = require("redis");

const { env } = require("./env");

let redisClient = null;
let redisConnected = false;
let connectPromise = null;
let missingConfigWarningShown = false;

/**
 * Prevent cache stampede
 * Stores active loader promises
 */
const pendingLoads = new Map();

/* -------------------------------------------------------------------------- */
/*                                CONFIG CHECK                                */
/* -------------------------------------------------------------------------- */

function isCacheConfigured() {
  return env.CACHE_ENABLED && Boolean(env.REDIS_URL);
}

function scopedKey(key) {
  return `${env.REDIS_PREFIX}:${key}`;
}

/* -------------------------------------------------------------------------- */
/*                              STABLE HASHING                                */
/* -------------------------------------------------------------------------- */

function stableNormalize(value) {
  if (Array.isArray(value)) {
    return value.map(stableNormalize);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, currentKey) => {
        acc[currentKey] = stableNormalize(value[currentKey]);
        return acc;
      }, {});
  }

  return value;
}

function hashPayload(payload) {
  const normalized = stableNormalize(payload);
  const serialized = JSON.stringify(normalized);

  return crypto
    .createHash("sha256")
    .update(serialized)
    .digest("hex")
    .slice(0, 24);
}

/* -------------------------------------------------------------------------- */
/*                              REDIS EVENTS                                  */
/* -------------------------------------------------------------------------- */

function attachRedisEvents(client) {
  client.on("connect", () => {
    console.log("Redis connecting...");
  });

  client.on("ready", () => {
    redisConnected = true;
    console.log("Redis cache connected");
  });

  client.on("reconnecting", () => {
    redisConnected = false;
    console.warn("Redis reconnecting...");
  });

  client.on("end", () => {
    redisConnected = false;
    console.warn("Redis cache connection closed");
  });

  client.on("error", (error) => {
    redisConnected = false;
    console.error("Redis cache error:", error.message);
  });
}

/* -------------------------------------------------------------------------- */
/*                             REDIS CONNECTION                               */
/* -------------------------------------------------------------------------- */

async function getRedisClient() {
  if (!env.CACHE_ENABLED) {
    return null;
  }

  if (!env.REDIS_URL) {
    if (!missingConfigWarningShown) {
      missingConfigWarningShown = true;

      console.warn(
        "CACHE_ENABLED is true but REDIS_URL is missing. Cache disabled."
      );
    }

    return null;
  }

  if (!redisClient) {
    redisClient = createClient({
      url: env.REDIS_URL,

      socket: {
        connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,

        reconnectStrategy(retries) {
          return Math.min(retries * 100, 3000);
        },
      },
    });

    attachRedisEvents(redisClient);
  }

  /**
   * Extra safety check
   */
  if (redisClient.isOpen) {
    redisConnected = true;
    return redisClient;
  }

  if (!connectPromise) {
    connectPromise = redisClient
      .connect()
      .catch((error) => {
        redisConnected = false;

        console.error(
          "Redis cache connect failed:",
          error.message
        );

        return null;
      })
      .finally(() => {
        connectPromise = null;
      });
  }

  await connectPromise;

  return redisConnected ? redisClient : null;
}

async function warmupCacheConnection() {
  if (!isCacheConfigured()) {
    return false;
  }

  const client = await getRedisClient();

  return Boolean(client);
}

/* -------------------------------------------------------------------------- */
/*                               CACHE GET                                    */
/* -------------------------------------------------------------------------- */

async function getJson(key) {
  const client = await getRedisClient();

  if (!client) {
    return null;
  }

  try {
    const raw = await client.get(scopedKey(key));

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch (parseError) {
      console.error(
        "Invalid cached JSON:",
        parseError.message
      );

      return null;
    }
  } catch (error) {
    console.error(
      "Cache getJson failed:",
      error.message
    );

    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                               CACHE SET                                    */
/* -------------------------------------------------------------------------- */

async function setJson(
  key,
  value,
  ttlSeconds = env.CACHE_DEFAULT_TTL_SECONDS
) {
  const client = await getRedisClient();

  if (!client) {
    return false;
  }

  /**
   * Avoid storing undefined
   */
  if (typeof value === "undefined") {
    return false;
  }

  try {
    await client.set(
      scopedKey(key),
      JSON.stringify(value),
      {
        EX: ttlSeconds,
      }
    );

    return true;
  } catch (error) {
    console.error(
      "Cache setJson failed:",
      error.message
    );

    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                           CACHE GET OR SET                                 */
/* -------------------------------------------------------------------------- */

async function getOrSetJson(
  key,
  loader,
  ttlSeconds = env.CACHE_DEFAULT_TTL_SECONDS
) {
  const cached = await getJson(key);

  if (cached !== null) {
    return cached;
  }

  /**
   * Prevent duplicate concurrent loaders
   */
  if (pendingLoads.has(key)) {
    return pendingLoads.get(key);
  }

  const loadPromise = (async () => {
    try {
      const fresh = await loader();

      if (typeof fresh !== "undefined") {
        await setJson(key, fresh, ttlSeconds);
      }

      return fresh;
    } finally {
      pendingLoads.delete(key);
    }
  })();

  pendingLoads.set(key, loadPromise);

  return loadPromise;
}

/* -------------------------------------------------------------------------- */
/*                               DELETE KEY                                   */
/* -------------------------------------------------------------------------- */

async function deleteKey(key) {
  const client = await getRedisClient();

  if (!client) {
    return 0;
  }

  try {
    return await client.del(scopedKey(key));
  } catch (error) {
    console.error(
      "Cache deleteKey failed:",
      error.message
    );

    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/*                           DELETE BY PREFIX                                 */
/* -------------------------------------------------------------------------- */

async function deleteByPrefix(prefix) {
  const client = await getRedisClient();

  if (!client) {
    return 0;
  }

  const matchPattern = scopedKey(`${prefix}*`);

  let cursor = "0";
  let deleted = 0;

  try {
    do {
      const result = await client.scan(cursor, {
        MATCH: matchPattern,
        COUNT: 100,
      });

      cursor = result.cursor;

      if (result.keys.length > 0) {
        deleted += await client.del(...result.keys);
      }
    } while (cursor !== "0");

    return deleted;
  } catch (error) {
    console.error(
      "Cache deleteByPrefix failed:",
      error.message
    );

    return deleted;
  }
}

/* -------------------------------------------------------------------------- */
/*                          GRACEFUL SHUTDOWN                                 */
/* -------------------------------------------------------------------------- */

async function disconnectRedis() {
  try {
    if (redisClient?.isOpen) {
      await redisClient.quit();
      redisConnected = false;

      console.log("Redis disconnected gracefully");
    }
  } catch (error) {
    console.error(
      "Redis disconnect failed:",
      error.message
    );
  }
}

process.on("SIGINT", async () => {
  await disconnectRedis();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await disconnectRedis();
  process.exit(0);
});

/* -------------------------------------------------------------------------- */
/*                                  EXPORTS                                   */
/* -------------------------------------------------------------------------- */

module.exports = {
  isCacheConfigured,
  warmupCacheConnection,

  hashPayload,

  getJson,
  setJson,
  getOrSetJson,

  deleteKey,
  deleteByPrefix,

  disconnectRedis,
};