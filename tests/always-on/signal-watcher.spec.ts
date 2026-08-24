import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SignalWatcher } from "../../src/always-on/runtime/SignalWatcher.js";

type WatchCallback = (event: string, filename: string | Buffer | null) => void;

test("SignalWatcher debounces changes, ignores configured paths, and closes cleanly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-signal-watcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let callback!: WatchCallback;
  let closeCount = 0;
  let signals = 0;
  const watcher = new SignalWatcher({
    projectRoot: root,
    ignoreGlobs: [".pilotdeck/**", "*.tmp", "**/ignored?.txt", "literal.[x]"],
    debounceMs: 50,
    baselineAt: new Date("2026-08-24T00:00:00.000Z"),
    watchFn: ((_path, _options, onChange) => {
      callback = onChange as WatchCallback;
      return {
        on: () => undefined,
        close: () => { closeCount += 1; },
      } as never;
    }) as never,
    onSignal: () => { signals += 1; },
  });

  watcher.start();
  watcher.start();
  callback("change", Buffer.from("src/index.ts"));
  callback("change", "src/next.ts");
  callback("change", ".pilotdeck/state.json");
  callback("change", "notes.tmp");
  callback("change", "nested/ignored1.txt");
  callback("change", "literal.[x]");
  callback("change", null);
  assert.equal(signals, 0);
  t.mock.timers.tick(49);
  assert.equal(signals, 0);
  t.mock.timers.tick(1);
  assert.equal(signals, 1);

  watcher.handleEvent("src/next.ts");
  watcher.stop();
  t.mock.timers.tick(100);
  assert.equal(signals, 1);
  assert.equal(closeCount, 1);
  watcher.handleEvent("src/after-stop.ts");
  t.mock.timers.reset();

  const alreadyStopped = new SignalWatcher({
    projectRoot: root,
    ignoreGlobs: [],
    debounceMs: 0,
    baselineAt: new Date(),
    onSignal: () => { throw new Error("stopped watcher fired"); },
  });
  alreadyStopped.stop();
  alreadyStopped.start();
});

test("SignalWatcher reports missing roots and watcher errors", async (t) => {
  const errors: string[] = [];
  const missing = new SignalWatcher({
    projectRoot: join(tmpdir(), "pilotdeck-signal-missing-root"),
    ignoreGlobs: [],
    debounceMs: 0,
    baselineAt: new Date(),
    onSignal: () => undefined,
    onError: (error) => errors.push(error.message),
  });
  missing.start();
  assert.match(errors[0] ?? "", /projectRoot not found/);

  const root = await mkdtemp(join(tmpdir(), "pilotdeck-signal-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let errorHandler!: (error: Error) => void;
  const watcher = new SignalWatcher({
    projectRoot: root,
    ignoreGlobs: [],
    debounceMs: 1,
    baselineAt: new Date(),
    onSignal: () => undefined,
    onError: (error) => errors.push(error.message),
    watchFn: (() => ({
      on: (_event: string, handler: (error: Error) => void) => { errorHandler = handler; },
      close: () => undefined,
    })) as never,
  });
  watcher.start();
  errorHandler(new Error("watch failed"));
  errorHandler("watch failed as text" as never);
  assert.ok(errors.includes("watch failed"));
  assert.ok(errors.includes("watch failed as text"));
  watcher.stop();

  const throwing = new SignalWatcher({
    projectRoot: root,
    ignoreGlobs: [],
    debounceMs: 0,
    baselineAt: new Date(),
    onSignal: () => undefined,
    onError: (error) => errors.push(error.message),
    watchFn: (() => { throw new Error("watch setup failed"); }) as never,
  });
  throwing.start();
  assert.ok(errors.includes("watch setup failed"));
});
