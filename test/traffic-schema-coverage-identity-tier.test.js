import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import pg from "pg";

const { Pool } = pg;
const sql = (path) => readFile(new URL(`../supabase/${path}`, import.meta.url), "utf8");
const CHECK = "traffic_coverage_snapshots_by_identity_tier_check";
const TIERS = ["verified", "declared", "anonymous", "rejected", "not_assessed"];

describe("Coverage snapshot identity tier split: migration, guards and rollback", { skip: !process.env.TEST_DATABASE_URL }, () => {
  const schema = `qa_${randomUUID().replaceAll("-", "")}`;
  const org = "user_coverage_tier_test";
  const split = { verified: 0, declared: 2, anonymous: 5, rejected: 1, not_assessed: 2 };
  let pool;
  let up;
  let down;
  let projectId;

  const columns = async () => (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'traffic_coverage_snapshots' ORDER BY 1`, [schema])).rows.map((row) => row.column_name);
  const insertOld = (date) => pool.query(`INSERT INTO "${schema}".traffic_coverage_snapshots (org_id, project_id, date, total_requests, by_bucket, method_version) VALUES ($1, $2, $3, 10, '{"unknown":0}', 'm1')`, [org, projectId, date]);
  const insert = (byIdentityTier, date) => pool.query(
    `INSERT INTO "${schema}".traffic_coverage_snapshots (org_id, project_id, date, total_requests, by_bucket, by_identity_tier, method_version) VALUES ($1, $2, $3, 10, '{"unknown":0}', $4::jsonb, 'm1')`,
    [org, projectId, date, byIdentityTier === null ? null : JSON.stringify(byIdentityTier)],
  );
  const inOneTransaction = async (text) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(text);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  before(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
    for (const file of ["migrations/20260920014916_dashboard_accounts.sql", "migrations/20260922120000_signup_limits.sql", "migrations/20261016120000_traffic.sql", "migrations/20261016220445_traffic_identity_tier.sql"]) await pool.query((await sql(file)).replaceAll("tanso_private", schema));
    up = (await sql("migrations/20261018191036_traffic_coverage_identity_tier.sql")).replaceAll("tanso_private", schema);
    down = (await sql("rollbacks/20261018191036_traffic_coverage_identity_tier.down.sql")).replaceAll("tanso_private", schema);
    await pool.query(`INSERT INTO "${schema}".agent_ready_accounts (account_id, state) VALUES ($1, $2::jsonb)`, [org, JSON.stringify({ owner: org, runs: [], balance: 0, reserved: 0 })]);
    projectId = (await pool.query(`INSERT INTO "${schema}".traffic_projects (org_id, name) VALUES ($1, 'acme-dev') RETURNING project_id`, [org])).rows[0].project_id;
  });

  after(async () => {
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); }
  });

  test("the migration fails cleanly when a snapshot row already exists and changes nothing", async (t) => {
    await insertOld("2026-10-01");
    const before = await columns();
    await assert.rejects(inOneTransaction(up), (err) => {
      t.diagnostic(`postgres error ${err.code}: ${err.message}`);
      assert.equal(err.code, "23502");
      assert.match(err.message, /column "by_identity_tier" of relation "traffic_coverage_snapshots" contains null values/);
      return true;
    });
    assert.deepEqual(await columns(), before);
    assert.ok(!before.includes("by_identity_tier"));
    const constraint = await pool.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = $1 AND connamespace = $2::regnamespace`, [CHECK, schema]);
    assert.equal(constraint.rows[0].n, 0);
    await pool.query(`DELETE FROM "${schema}".traffic_coverage_snapshots`);
  });

  test("the migration applies on an empty table", async () => {
    await inOneTransaction(up);
    assert.ok((await columns()).includes("by_identity_tier"));
    const { rows } = await pool.query(`SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'traffic_coverage_snapshots' AND column_name = 'by_identity_tier'`, [schema]);
    assert.deepEqual(rows, [{ is_nullable: "NO", column_default: null }]);
  });

  test("a snapshot with all five tiers inserts, verified at zero included", async () => {
    await insert(split, "2026-10-02");
    const { rows } = await pool.query(`SELECT by_identity_tier FROM "${schema}".traffic_coverage_snapshots WHERE date = '2026-10-02'`);
    assert.deepEqual(rows, [{ by_identity_tier: split }]);
  });

  for (const [i, tier] of TIERS.entries()) {
    test(`a snapshot without ${tier} is refused by the named check`, async () => {
      const { [tier]: _, ...missing } = split;
      await assert.rejects(insert(missing, `2026-09-${String(i + 10)}`), (err) => {
        assert.equal(err.code, "23514");
        assert.equal(err.constraint, CHECK);
        return true;
      });
    });
  }

  test("a snapshot with no identity tier split is refused", async () => {
    await assert.rejects(insert(null, "2026-09-20"), (err) => {
      assert.equal(err.code, "23502");
      assert.equal(err.column, "by_identity_tier");
      return true;
    });
  });

  test("an identity tier split given as an array or a string is refused by the named check", async () => {
    for (const value of [TIERS, "verified"]) {
      await assert.rejects(insert(value, "2026-09-21"), (err) => {
        assert.equal(err.code, "23514");
        assert.equal(err.constraint, CHECK);
        return true;
      });
    }
  });

  test("the rollback drops the column and keeps the snapshot rows; the migration reapplies on an empty table", async () => {
    await insert(split, "2026-10-03");
    await inOneTransaction(down);
    assert.ok(!(await columns()).includes("by_identity_tier"));
    const { rows } = await pool.query(`SELECT to_char(date, 'YYYY-MM-DD') AS date, total_requests FROM "${schema}".traffic_coverage_snapshots ORDER BY date`);
    assert.deepEqual(rows, [{ date: "2026-10-02", total_requests: "10" }, { date: "2026-10-03", total_requests: "10" }]);
    await pool.query(`DELETE FROM "${schema}".traffic_coverage_snapshots`);
    await inOneTransaction(up);
    assert.ok((await columns()).includes("by_identity_tier"));
    await insert(split, "2026-10-04");
  });
});
