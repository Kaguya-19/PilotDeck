import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { serveStaticAsset } from "../../src/gateway/server/staticAssets.js";

class CaptureResponse extends Writable {
  statusCode?: number;
  headers?: Record<string, string>;
  readonly chunks: Buffer[] = [];

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

async function readResponse(response: CaptureResponse): Promise<string> {
  await once(response, "finish");
  return Buffer.concat(response.chunks).toString("utf8");
}

test("serveStaticAsset serves known files with stable content types", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-static-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<html>home</html>");
  await writeFile(join(root, "app.js"), "console.log('ok');");
  await writeFile(join(root, "payload.bin"), Buffer.from([1, 2, 3]));

  const html = new CaptureResponse();
  assert.equal(serveStaticAsset(root, "/", html as never), true);
  assert.equal(await readResponse(html), "<html>home</html>");
  assert.equal(html.statusCode, 200);
  assert.equal(html.headers?.["content-type"], "text/html; charset=utf-8");

  const script = new CaptureResponse();
  assert.equal(serveStaticAsset(root, "/app.js", script as never), true);
  assert.equal(await readResponse(script), "console.log('ok');");
  assert.equal(script.headers?.["content-type"], "text/javascript; charset=utf-8");

  const binary = new CaptureResponse();
  assert.equal(serveStaticAsset(root, "/payload.bin", binary as never), true);
  assert.deepEqual([...Buffer.from(await readResponse(binary))], [1, 2, 3]);
  assert.equal(binary.headers?.["content-type"], "application/octet-stream");
});

test("serveStaticAsset falls back to index for missing routes and rejects unsafe roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-static-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "shell");

  const fallback = new CaptureResponse();
  assert.equal(serveStaticAsset(root, "/missing-route", fallback as never), true);
  assert.equal(await readResponse(fallback), "shell");
  assert.equal(fallback.headers?.["content-type"], "text/html; charset=utf-8");

  assert.equal(serveStaticAsset("/", "/tmp", new CaptureResponse() as never), false);
  assert.equal(serveStaticAsset(join(root, "missing"), "/", new CaptureResponse() as never), false);
});
