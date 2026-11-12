import { backup, DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export function checkDatabaseFile(databasePath: string, persistent: boolean) {
  if (!persistent) return;
  const marker = `${databasePath}.initialized`;
  if (fs.existsSync(marker) && !fs.existsSync(databasePath)) {
    throw new Error("The persistent database is missing. Restore a verified backup before starting; refusing to create an empty database.");
  }
}

export function markDatabaseInitialized(databasePath: string, persistent: boolean) {
  if (persistent) fs.writeFileSync(`${databasePath}.initialized`, "Database initialized. Keep this marker when restoring backups.\n", { encoding: "utf8", flag: "wx" });
}

export async function snapshotDatabase(db: DatabaseSync, databasePath: string, keep = 48) {
  const directory = path.join(path.dirname(databasePath), "backups");
  fs.mkdirSync(directory, { recursive: true });
  const prefix = `${path.basename(databasePath)}.backup-`;
  const name = `${prefix}${Date.now()}-${crypto.randomUUID()}.db`;
  const destination = path.join(directory, name);
  await backup(db, destination);
  const copy = new DatabaseSync(destination);
  try {
    copy.exec("PRAGMA journal_mode=DELETE");
    const result = copy.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    if (result.length !== 1 || result[0].quick_check !== "ok") throw new Error("Database backup integrity check failed");
  } finally { copy.close(); }
  const previous = fs.readdirSync(directory).filter(file => file.startsWith(prefix) && file.endsWith(".db"))
    .sort().reverse();
  for (const file of previous.slice(keep)) fs.unlinkSync(path.join(directory, file));
  return destination;
}

export async function startDatabaseBackups(db: DatabaseSync, databasePath: string) {
  await snapshotDatabase(db, databasePath);
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await snapshotDatabase(db, databasePath); }
    catch (error) { console.error("Database backup failed", error); }
    finally { running = false; }
  }, 60 * 60 * 1000);
  timer.unref();
}
