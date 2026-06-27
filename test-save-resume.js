const { pool, initPostgres } = require("./src/config/database.postgres");

async function testPostgres() {
  console.log("Initializing Postgres database/table...");
  await initPostgres();

  console.log("Testing connection query...");
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("SUCCESS! Postgres is reachable. Server time:", res.rows[0].now);
  } catch (err) {
    console.error("FAILED! Postgres connection failed with error:", err);
  } finally {
    await pool.end();
  }
}

testPostgres();
