import { startBot } from "./bot.js";
import { startWeb } from "./web.js";
import { startDatabaseBackups } from "./database-backups.js";
import { db } from "./db.js";
import { config } from "./config.js";

await startDatabaseBackups(db, config.databasePath);
await startBot();
startWeb();
