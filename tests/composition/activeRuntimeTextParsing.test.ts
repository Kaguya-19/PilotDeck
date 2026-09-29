import assert from "node:assert/strict";
import { test } from "node:test";
import { createActiveRuntimeTextParsingPort } from "../../src/composition/activeRuntimeTextParsing.js";
import { createRuntimeHostCapabilityProvider } from "../../src/composition/publicHostRuntimeAdapter.js";

const encode = (text: string) => Buffer.from(text).toString("base64");
const principal = { pilotDeckUserId: "pd", tenantId: "tenant", actorUserId: "actor" };

test("PD text Port extracts original UTF-8 bytes without creating a task", async () => {
  const parse = createActiveRuntimeTextParsingPort();
  const provider = createRuntimeHostCapabilityProvider({
    profile: { id: "active" }, model: {}, tools: {}, skills: {}, file: { parse },
    context: { forTool: () => { throw Error("unbound"); } },
  });
  const result = await provider.call("file_parse", { filename: "unique.md", content_base64: encode("独有事实"),
    max_bytes: 1024 }, { principal });
  assert.equal(result.status, 200);
  assert.equal((result.body as { text: string }).text, "独有事实");
  assert.equal((result.body as { metadata: { fileType: string } }).metadata.fileType, "md");
});

test("unsupported format, size and invalid UTF-8 reject with real status", async () => {
  const parse = createActiveRuntimeTextParsingPort();
  await assert.rejects(parse({ filename: "a.pdf", bytes: Buffer.from("pdf") }), { status: 415 });
  await assert.rejects(parse({ filename: "a.txt", bytes: Buffer.from("big"), maxBytes: 1 }), { status: 413 });
  await assert.rejects(parse({ filename: "a.txt", bytes: Uint8Array.of(0xff) }), { status: 422 });
});
