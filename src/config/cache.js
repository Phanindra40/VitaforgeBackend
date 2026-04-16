const crypto = require("crypto");
const { createClient } = require("redis");

const { env } = require("./env");

let redisClient = null;
let redisConnected = false;
let connectPromise = null;
let missingConfigWarningShown = false;

function isCacheConfigured() {
  return env.CACHE_ENABLED && Boolean(env.REDIS_URL);
}

function scopedKey(key) {
  return `${env.REDIS_PREFIX}:${key}`;
}

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
  return crypto.createHash("sha256").update(serialized).digest("hex").slice(0, 24);
}

function attachRedisEvents(client) {
  client.on("ready", () => {
    redisConnected = true;
    console.log("Redis cache connected");
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

async function getRedisClient() {
  if (!env.CACHE_ENABLED) {
    return null;
  }

  if (!env.REDIS_URL) {
    if (!missingConfigWarningShown) {
      missingConfigWarningShown = true;
      console.warn("CACHE_ENABLED is true but REDIS_URL is not set. Caching is disabled.");
    }
    return null;
  }

  if (!redisClient) {
    redisClient = createClient({
      url: env.REDIS_URL,
      socket: {
        connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
      },
    });
    attachRedisEvents(redisClient);
  }

  if (redisConnected) {
    return redisClient;
  }

  if (!connectPromise) {
    connectPromise = redisClient.connect().catch((error) => {
      console.error("Redis cache connect failed:", error.message);
      return null;
    }).finally(() => {
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

async function getJson(key) {
  const client = await getRedisClient();
  if (!client) return null;

  try {
    const raw = await client.get(scopedKey(key));
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error("Cache getJson failed:", error.message);
    return null;
  }
}

async function setJson(key, value, ttlSeconds = env.CACHE_DEFAULT_TTL_SECONDS) {
  const client = await getRedisClient();
  if (!client) return false;

  try {
    await client.set(scopedKey(key), JSON.stringify(value), { EX: ttlSeconds });
    return true;
  } catch (error) {
    console.error("Cache setJson failed:", error.message);
    return false;
  }
}

async function getOrSetJson(key, loader, ttlSeconds = env.CACHE_DEFAULT_TTL_SECONDS) {
  const cached = await getJson(key);
  if (cached !== null) {
    return cached;
  }

  const fresh = await loader();
  await setJson(key, fresh, ttlSeconds);
  return fresh;
}

async function deleteKey(key) {
  const client = await getRedisClient();
  if (!client) return 0;

  try {
    return await client.del(scopedKey(key));
  } catch (error) {
    console.error("Cache deleteKey failed:", error.message);
    return 0;
  }
}

async function deleteByPrefix(prefix) {
  const client = await getRedisClient();
  if (!client) return 0;

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
      if (result.keys.length) {
        deleted += await client.del(result.keys);
      }
    } while (cursor !== "0");

    return deleted;
  } catch (error) {
    console.error("Cache deleteByPrefix failed:", error.message);
    return deleted;
  }
}

module.exports = {
  isCacheConfigured,
  warmupCacheConnection,
  hashPayload,
  getJson,
  setJson,
  getOrSetJson,
  deleteKey,
  deleteByPrefix,
};
