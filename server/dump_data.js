const { Pool } = require("pg");
(async () => {
  const p = new Pool({ user: "postgres", host: "localhost", database: "ai_drainos", password: "admin123", port: 5432 });
  for (const t of ["drains", "robots", "sensors", "alerts", "missions", "charging_stations", "users"]) {
    const q = await p.query(`SELECT * FROM ${t} ORDER BY id LIMIT 15`);
    console.log("\n===== " + t + " =====");
    console.log(JSON.stringify(q.rows, null, 1));
  }
  await p.end();
})().catch((e) => { console.log("ERR", e.message); process.exit(1); });