import pg from "pg";

const { Pool } = pg;

// pg returns BIGINT (and COUNT(*)) as strings by default, to avoid silent
// precision loss on huge numbers. This app's counts are always small, so
// parse them as plain JS numbers everywhere - matches how SQLite behaved.
pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // OID 20 = int8/bigint

// The schema uses the real DATE and TIMESTAMP types (section 4 of the requirements), but the app
// handles dates as plain text: DATE comes back as "YYYY-MM-DD", and TIMESTAMP (which here always
// holds UTC) as ISO-8601 with a Z, so Date.parse() reads it the same way on any server.
pg.types.setTypeParser(1082, (v) => v);                            // OID 1082 = date
// Postgres drops trailing zeros from the fraction of a second ("...56.67" for 56.670), so it is padded (or cut) to exactly
// three digits: every timestamp the app sees looks the same, ".670" and ".000" included.
pg.types.setTypeParser(1114, (v) => {                              // OID 1114 = timestamp without time zone
  const [date, time = "00:00:00"] = v.split(" ");
  const [hms, fraction = ""] = time.split(".");
  return `${date}T${hms}.${fraction.padEnd(3, "0").slice(0, 3)}Z`;
});

export function openDb(connectionString) {
  const pool = new Pool({ connectionString });
  // Postgres reports WARNINGs (such as "Schema upgrade skipped" from schema.sql) as notices, which node-pg
  // silently drops unless something listens. Only warnings are shown: NOTICEs like "table already exists,
  // skipping" would otherwise print on every start.
  pool.on("connect", (client) => client.on("notice", (n) => { if (n.severity === "WARNING") console.warn(`[postgres] ${n.message}`); }));
  return {
    query: (text, params) => pool.query(text, params),
    pool,
    prepare: (sql) => statement(pool, sql),
    close: () => pool.end(),
  };
}

// Mimics node:sqlite's prepared-statement shape (.get/.all/.run), so the
// rest of the app barely changed when the database engine did - every call
// site just gained an "await". Supports both styles already used in this
// codebase: positional "?" placeholders, and named "@name" placeholders
// (used wherever a single object is passed in, e.g. .run({ id, email })).
function statement(runner, sql) {
  const names = [...sql.matchAll(/@(\w+)/g)].map((m) => m[1]);
  const isNamed = names.length > 0;
  let i = 0;
  const text = isNamed ? sql.replace(/@(\w+)/g, () => `$${++i}`) : sql.replace(/\?/g, () => `$${++i}`);

  async function exec(args) {
    const params = isNamed ? names.map((n) => args[0][n]) : args;
    return runner.query(text, params);
  }

  return {
    async get(...args) { return (await exec(args)).rows[0]; },
    async all(...args) { return (await exec(args)).rows; },
    async run(...args) { const r = await exec(args); return { changes: r.rowCount }; },
  };
}

// All-or-nothing group of statements. fn receives a transaction-scoped `tx`
// (same shape as the db passed to openDb) - every query inside fn MUST go
// through tx, not the outer db, so it actually runs on the same connection
// as the BEGIN/COMMIT (the app holds a pool of connections, not just one).
export async function transaction(db, fn) {
  const client = await db.pool.connect();
  const tx = { query: (text, params) => client.query(text, params), pool: client, prepare: (sql) => statement(client, sql) };
  try {
    await client.query("BEGIN");
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export const isUniqueViolation = (err) => err?.code === "23505";