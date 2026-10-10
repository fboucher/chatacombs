import http from 'node:http';
import { createApp } from './server/app.js';
import { createDatabase, runMigrations } from './db/database.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Initialize SQLite database
const db = createDatabase();
runMigrations(db);

// Create Express app
const app = createApp({ db });

const server = http.createServer(app);

server.listen(PORT, HOST, () => {
  console.log(`🏰 Chatacombs service running on http://${HOST}:${PORT}`);
});
