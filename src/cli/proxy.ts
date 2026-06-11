type EnvLike = Record<string, string | undefined>;

/**
 * Read the active proxy URL from environment variables.
 * Priority: PILOTDECK_PROXY > https_proxy > HTTPS_PROXY > http_proxy > HTTP_PROXY
 */
export function getProxyUrl(env: EnvLike = process.env): string | undefined {
  return (
    env.PILOTDECK_PROXY ||
    env.https_proxy ||
    env.HTTPS_PROXY ||
    env.http_proxy ||
    env.HTTP_PROXY
  );
}

/**
 * Install a global undici EnvHttpProxyAgent so that all native
 * `fetch()` and `WebSocket` calls in the process are routed through
 * the configured HTTP/HTTPS proxy, while respecting `NO_PROXY`.
 *
 * `127.0.0.1` and `localhost` are always excluded — the gateway
 * WebSocket lives on loopback and must never be routed through an
 * external proxy.
 *
 * Node.js native fetch (backed by undici) does NOT respect the
 * standard HTTPS_PROXY / HTTP_PROXY env vars — unlike curl or Python
 * requests. This function bridges that gap via `setGlobalDispatcher`.
 *
 * Safe to call multiple times; only the first effective call installs.
 * Use {@link reinstallGlobalProxy} when the proxy URL changes at runtime.
 * Returns the proxy URL that was activated, or undefined if none.
 */
let installed = false;
let pendingInstall: Promise<string | undefined> | null = null;

export async function installGlobalProxy(explicitUrl?: string): Promise<string | undefined> {
  if (installed) return undefined;
  if (pendingInstall) return pendingInstall;

  const proxyUrl = explicitUrl ?? getProxyUrl();
  if (!proxyUrl) return undefined;

  pendingInstall = applyGlobalProxy(proxyUrl).finally(() => {
    pendingInstall = null;
  });
  return pendingInstall;
}

/**
 * Unconditionally (re-)install the global proxy dispatcher.
 * Called by hot-reload paths when `proxy.*` config changes at runtime.
 * Passing `undefined` or empty string removes the proxy (resets to
 * a no-op agent so outbound requests go direct).
 */
export async function reinstallGlobalProxy(
  proxyUrl: string | undefined,
  extraNoProxy?: string,
): Promise<string | undefined> {
  if (pendingInstall) await pendingInstall;

  if (!proxyUrl) {
    try {
      const { Agent, setGlobalDispatcher } = await import("undici");
      setGlobalDispatcher(new Agent());
      installed = false;
      console.log("[proxy] Global fetch proxy removed");
    } catch {
      // best effort
    }
    return undefined;
  }
  return applyGlobalProxy(proxyUrl, extraNoProxy);
}

async function applyGlobalProxy(
  proxyUrl: string,
  extraNoProxy?: string,
): Promise<string | undefined> {
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
    const userNoProxy = process.env.no_proxy || process.env.NO_PROXY || "";
    const noProxy = [userNoProxy, extraNoProxy, "127.0.0.1", "localhost"]
      .filter(Boolean)
      .join(",");
    const agent = new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy,
    });
    setGlobalDispatcher(agent);
    installed = true;
    console.log(`[proxy] Global fetch proxy → ${proxyUrl} (noProxy: ${noProxy})`);
    return proxyUrl;
  } catch (error) {
    console.warn(
      `[proxy] Failed to install global proxy (${proxyUrl}):`,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}
