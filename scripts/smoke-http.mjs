// HTTP for the smoke scripts: every request on a connection of its own, with a time limit.
// fetch keeps sockets alive, and one a starting server drops can leave its promise pending
// until Node ends the script with exit code 13 and no output.
import http from 'node:http';

/** Resolves to `{ status, body, json() }`; rejects when no answer came within `timeoutMs`. */
export function request(url, { method = 'GET', headers = {}, body, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text, json: () => JSON.parse(text) });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from ${url} within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}
