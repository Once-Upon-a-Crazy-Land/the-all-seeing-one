import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { snapshotDatabase, checkDatabaseFile, markDatabaseInitialized } from "../src/database-backups.js";
import { databasePathFor } from "../src/database-path.js";
import { xpRange } from "../src/xp-range.js";

test("new and legacy systems earn configured default XP; explicit zero stays disabled", () => {
  const settings = { min_xp: 15, max_xp: 25, min_xp_values: "", max_xp_values: "" };
  assert.deepEqual(xpRange(settings, 0), { minimum: 15, maximum: 25 });
  assert.deepEqual(xpRange({ ...settings, min_xp_values: "0", max_xp_values: "0" }, 0), { minimum: 0, maximum: 0 });
  assert.deepEqual(xpRange({ ...settings, min_xp_values: "15,0", max_xp_values: "25,0" }, 1), { minimum: 0, maximum: 0 });
});

test("Railway cannot start without persistent storage", () => {
  assert.throws(() => databasePathFor({ RAILWAY_ENVIRONMENT_ID: "production" }), /persistent Railway volume/);
});

test("backups retain committed WAL data, rotate, and prevent silent empty recreation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-backup-test-"));
  const filename = path.join(directory, "bot.db");
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE balances(user_id TEXT,cash INTEGER); INSERT INTO balances VALUES('member',123)");
    const first = await snapshotDatabase(db, filename, 2);
    const restored = new DatabaseSync(first, { readOnly: true });
    try { assert.equal(restored.prepare("SELECT cash FROM balances").get()!.cash, 123); }
    finally { restored.close(); }
    await new Promise(resolve => setTimeout(resolve, 5));
    await snapshotDatabase(db, filename, 2);
    await new Promise(resolve => setTimeout(resolve, 5));
    await snapshotDatabase(db, filename, 2);
    assert.equal(fs.readdirSync(path.join(directory, "backups")).length, 2);
    assert.equal(fs.existsSync(first), false);
    markDatabaseInitialized(filename, true);
    checkDatabaseFile(filename, true);
  } finally { db.close(); }
  try {
    fs.unlinkSync(filename);
    assert.throws(() => checkDatabaseFile(filename, true), /refusing to create an empty database/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
