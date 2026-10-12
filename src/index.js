import http from 'node:http';
import { createApp } from './server/app.js';
import { createDatabase, runMigrations } from './db/database.js';
import { AiClient } from './ai/client.js';
import { describeSoul } from './ai/soul.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Initialize SQLite database
const db = createDatabase();
runMigrations(db);

// Create Express app
const app = createApp({ db });

const server = http.createServer(app);

server.listen(PORT, HOST, () => {
  console.log(`🏰 Chatacombs service running on http://${HOST}:${PORT} (db: ${db.name})`);
  console.log(`🤖 AI narration: ${new AiClient().describe()}`);
  console.log(`📜 Soul: ${describeSoul()}`);
});

// Shut down cleanly on `docker stop` / Ctrl+C so SQLite checkpoints its WAL
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close();
  server.closeAllConnections?.(); // SSE streams never end on their own
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
