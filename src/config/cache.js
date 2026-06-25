const crypto = require("crypto");
const { createClient } = require("redis");
const axios = require("axios");

const { env } = require("./env");
const { logger } = require("../utils/logger");

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
  return (
    env.CACHE_ENABLED &&
    (Boolean(env.REDIS_URL) ||
      (Boolean(env.UPSTASH_REDIS_REST_URL) &&
        Boolean(env.UPSTASH_REDIS_REST_TOKEN)))
  );
}

const upstashRestClient = {
  async get(key) {
    const response = await axios.post(
      env.UPSTASH_REDIS_REST_URL,
      ["GET", key],
      {
        headers: {
          Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: env.REDIS_CONNECT_TIMEOUT_MS,
      }
    );
    return response.data.result;
  },
  async set(key, value, options = {}) {
    const command = ["SET", key, value];
    if (options.EX) {
      command.push("EX", options.EX);
    }
    const response = await axios.post(
      env.UPSTASH_REDIS_REST_URL,
      command,
      {
        headers: {
          Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: env.REDIS_CONNECT_TIMEOUT_MS,
      }
    );
    return response.data.result;
  },
  async del(...keys) {
    if (!keys.length) return 0;
    const response = await axios.post(
      env.UPSTASH_REDIS_REST_URL,
      ["DEL", ...keys],
      {
        headers: {
          Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: env.REDIS_CONNECT_TIMEOUT_MS,
      }
    );
    return response.data.result || 0;
  },
  async scan(cursor, options = {}) {
    const command = ["SCAN", cursor];
    if (options.MATCH) {
      command.push("MATCH", options.MATCH);
    }
    if (options.COUNT) {
      command.push("COUNT", options.COUNT);
    }
    const response = await axios.post(
      env.UPSTASH_REDIS_REST_URL,
      command,
      {
        headers: {
          Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: env.REDIS_CONNECT_TIMEOUT_MS,
      }
    );
    const [nextCursor, keys] = response.data.result || ["0", []];
    return { cursor: nextCursor, keys };
  },
  async ping() {
    const response = await axios.post(
      env.UPSTASH_REDIS_REST_URL,
      ["PING"],
      {
        headers: {
          Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: env.REDIS_CONNECT_TIMEOUT_MS,
      }
    );
    return response.data.result;
  }
};


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
    logger.info("Redis connecting...");
  });

  client.on("ready", () => {
    redisConnected = true;
    logger.info("Redis cache connected");
  });

  client.on("reconnecting", () => {
    redisConnected = false;
    logger.warn("Redis reconnecting...");
  });

  client.on("end", () => {
    redisConnected = false;
    logger.warn("Redis cache connection closed");
  });

  client.on("error", (error) => {
    redisConnected = false;
    logger.error("Redis cache error", error);
  });
}

/* -------------------------------------------------------------------------- */
/*                             REDIS CONNECTION                               */
/* -------------------------------------------------------------------------- */

async function getRedisClient() {
  if (!env.CACHE_ENABLED) {
    return null;
  }

  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    redisConnected = true;
    return upstashRestClient;
  }

  if (!env.REDIS_URL) {
    if (!missingConfigWarningShown) {
      missingConfigWarningShown = true;

      logger.warn("CACHE_ENABLED is true but REDIS_URL and Upstash REST config are missing. Cache disabled.");
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

        logger.error("Redis cache connect failed", error);

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

  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const res = await upstashRestClient.ping();
      if (res === "PONG") {
        logger.info("Upstash Redis Cache connected (HTTP REST)");
        return true;
      }
      logger.error(`Upstash Redis PING returned unexpected result: ${res}`);
      return false;
    } catch (error) {
      logger.error("Upstash Redis Cache connection failed", error);
      return false;
    }
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
      logger.error("Invalid cached JSON", parseError);

      return null;
    }
  } catch (error) {
    logger.error("Cache getJson failed", error);

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
    logger.error("Cache setJson failed", error);

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
    logger.error("Cache deleteKey failed", error);

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
    logger.error("Cache deleteByPrefix failed", error);

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

      logger.info("Redis disconnected gracefully");
    }
  } catch (error) {
    logger.error("Redis disconnect failed", error);
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