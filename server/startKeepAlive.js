const app = require('./index');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3101);
const FINAL_DISPLAY_LONG_REQUEST_TIMEOUT_MS = 31 * 60 * 1000;

const server = app.listen(port, host, () => {
  console.log(`MYML Evidence Agent server listening at http://${host}:${port}`);
});
server.requestTimeout = Math.max(server.requestTimeout || 0, FINAL_DISPLAY_LONG_REQUEST_TIMEOUT_MS);
server.timeout = Math.max(server.timeout || 0, FINAL_DISPLAY_LONG_REQUEST_TIMEOUT_MS);
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 70 * 1000;

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping MYML Evidence Agent.`);

  server.close((error) => {
    if (error) {
      console.error('Evidence Agent shutdown failed.');
      process.exitCode = 1;
    }
    process.exit();
  });

  const forceExit = setTimeout(() => {
    console.error('Evidence Agent shutdown timed out.');
    process.exit(1);
  }, 30 * 1000);
  forceExit.unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
