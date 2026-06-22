import http from "node:http";

const DELAY_SECONDS = parseInt(process.env.MOCK_DELAY ?? "8", 10);
const PORT = parseInt(process.env.MOCK_PORT ?? "9999", 10);

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const url = req.url;
    console.log(`[mock] ${req.method} ${url} — will respond in ${DELAY_SECONDS}s`);

    if (url === "/v1/chat/completions") {
      // Simulate vLLM prefill + generation: no bytes for DELAY_SECONDS
      setTimeout(() => {
        if (res.destroyed) {
          console.log(`[mock] client already disconnected after ${DELAY_SECONDS}s`);
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "mock-slow-001",
          object: "chat.completion",
          model: "mock-slow",
          choices: [{
            index: 0,
            message: { role: "assistant", content: `Response after ${DELAY_SECONDS}s delay. The timeout/retry mechanism works!` },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }));
        console.log(`[mock] responded OK after ${DELAY_SECONDS}s`);
      }, DELAY_SECONDS * 1000);
    } else if (url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-slow", object: "model" }] }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n[mock-slow-provider] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[mock-slow-provider] Delay: ${DELAY_SECONDS}s per request`);
  console.log(`[mock-slow-provider] Endpoint: http://127.0.0.1:${PORT}/v1\n`);
  console.log(`To test timeout, set MOCK_DELAY > provider.timeoutMs/1000`);
  console.log(`Example: MOCK_DELAY=320 node scripts/mock-slow-provider.mjs\n`);
});
