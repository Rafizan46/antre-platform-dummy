// Container HEALTHCHECK: exits 0 when GET http://127.0.0.1:<port><path> answers 2xx within 3 s.
// Usage: node healthcheck.mjs <port> [path]   (path defaults to /healthz)
const port = process.argv[2];
const path = process.argv[3] ?? '/healthz';

try {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(3000),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
