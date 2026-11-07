// Entry point: config → database → app → listen. Domain timers start inside their register().
const { config } = require('./config');
const { open } = require('./db');
const { createApp, stopTimers } = require('./app');

function main() {
  const cfg = config();
  const db = open(cfg.dbFile);
  const app = createApp(cfg, db);
  const server = app.listen(cfg.port, () => {
    console.log(`Guild Camp server listening on http://localhost:${cfg.port} (public address ${cfg.baseUrl})`);
  });

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down.`);
    stopTimers(app);
    // Give open requests (uploads) a moment to finish, then close the database cleanly.
    const force = setTimeout(() => { console.warn('Forcing exit.'); process.exit(1); }, 10000);
    force.unref();
    server.close(() => {
      try { db.close(); } catch (e) { console.warn('Closing the database failed:', e.message); }
      process.exit(0);
    });
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (e) {
  console.error(`Guild Camp server could not start: ${e.message}`);
  process.exit(1);
}
