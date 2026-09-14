import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { CodeRuntimePort, CodeRuntimeRequest, CodeRuntimeResult } from "./CodeRuntimePort.js";

/** Native code-runtime provider for one detached process tree. */
export function createNodeCodeRuntimePort(): CodeRuntimePort {
  let state: "active" | "draining" | "disposed" = "active";
  let activeRuns = 0;
  const activeRunControllers = new Set<AbortController>();
  let drainPromise: Promise<void> | undefined;
  let resolveDrain: (() => void) | undefined;
  const whenDrained = () => {
    if (activeRuns === 0) return Promise.resolve();
    return drainPromise ??= new Promise<void>((resolve) => { resolveDrain = resolve; });
  };
  return {
    resolveExecutable: async (candidates, env, signal) => {
      if (state !== "active") throw new Error(`Code runtime is ${state}; refusing executable resolution.`);
      return resolveNodeExecutable(candidates, env, signal);
    },
    run: (request) => {
      if (state !== "active") return Promise.reject(new Error(`Code runtime is ${state}; refusing a new run.`));
      activeRuns += 1;
      const controller = new AbortController();
      activeRunControllers.add(controller);
      const onCallerAbort = () => controller.abort(request.signal?.reason);
      if (request.signal?.aborted) onCallerAbort();
      else request.signal?.addEventListener("abort", onCallerAbort, { once: true });
      return runNodeCodeRuntime({ ...request, signal: controller.signal }).finally(() => {
        request.signal?.removeEventListener("abort", onCallerAbort);
        activeRunControllers.delete(controller);
        activeRuns -= 1;
        if (activeRuns === 0) {
          resolveDrain?.();
          resolveDrain = undefined;
          drainPromise = undefined;
        }
      });
    },
    dispose: async () => {
      if (state === "disposed") return;
      state = "draining";
      for (const controller of activeRunControllers) {
        controller.abort(new Error("Code runtime provider is disposing."));
      }
      await whenDrained();
      state = "disposed";
    },
  };
}

async function resolveNodeExecutable(
  candidates: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    const available = await new Promise<boolean>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(candidate, ["--version"], { env, stdio: "ignore" });
      } catch {
        resolve(false);
        return;
      }
      const finish = (value: boolean) => {
        child.removeAllListeners();
        resolve(value);
      };
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
      signal?.addEventListener("abort", () => {
        try { child.kill("SIGTERM"); } catch { /* already exited */ }
        finish(false);
      }, { once: true });
    });
    if (available) return candidate;
  }
  return undefined;
}

function runNodeCodeRuntime(request: CodeRuntimeRequest): Promise<CodeRuntimeResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout = collectHeadTail(child.stdout, request.stdoutMaxBytes);
    const stderr = collectHead(child.stderr, request.stderrMaxBytes);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killProcess(child, true);
    }, request.timeoutMs);
    const onAbort = () => {
      if (settled) return;
      cancelled = true;
      killProcess(child, true);
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const stopObserving = () => {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      stopObserving();
      reject(error);
    });
    child.once("exit", (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      stopObserving();
      void Promise.all([stdout, stderr]).then(
        ([capturedStdout, capturedStderr]) => resolve({
          exitCode,
          exitSignal,
          stdout: capturedStdout,
          stderr: capturedStderr,
          timedOut,
          cancelled,
        }),
        reject,
      );
    });
  });
}

function collectHead(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (total < maxBytes) chunks.push(buffer.subarray(0, maxBytes - total));
      total += buffer.byteLength;
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function collectHeadTail(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const headBytes = Math.floor(maxBytes * 0.4);
  const tailBytes = maxBytes - headBytes;
  return new Promise((resolve) => {
    const head: Buffer[] = [];
    const tail: Buffer[] = [];
    let headCollected = 0;
    let tailCollected = 0;
    let total = 0;
    stream.on("data", (chunk: Buffer | string) => {
      let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (headCollected < headBytes) {
        const keep = Math.min(buffer.byteLength, headBytes - headCollected);
        head.push(buffer.subarray(0, keep));
        headCollected += keep;
        buffer = buffer.subarray(keep);
      }
      if (buffer.byteLength > 0) {
        tail.push(buffer);
        tailCollected += buffer.byteLength;
        while (tailCollected > tailBytes && tail.length > 0) {
          const first = tail[0]!;
          const overflow = tailCollected - tailBytes;
          if (overflow >= first.byteLength) {
            tail.shift();
            tailCollected -= first.byteLength;
          } else {
            tail[0] = first.subarray(overflow);
            tailCollected -= overflow;
          }
        }
      }
    });
    const finish = () => {
      const headText = Buffer.concat(head).toString("utf8");
      const tailText = Buffer.concat(tail).toString("utf8");
      if (total > maxBytes && tailText) {
        const omitted = Math.max(0, total - Buffer.byteLength(headText) - Buffer.byteLength(tailText));
        resolve(`${headText}\n\n... [OUTPUT TRUNCATED - ${omitted.toLocaleString()} bytes omitted out of ${total.toLocaleString()} total] ...\n\n${tailText}`);
      } else {
        resolve(headText + tailText);
      }
    };
    stream.on("end", finish);
    stream.on("error", finish);
  });
}

function killProcess(child: ChildProcessByStdio<null, Readable, Readable>, escalate: boolean): void {
  if (child.killed) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, "SIGTERM");
      if (escalate) setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* process already exited */ }
      }, 500).unref();
    } else {
      child.kill("SIGTERM");
      if (escalate) setTimeout(() => child.kill("SIGKILL"), 500).unref();
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* process already exited */ }
  }
}
