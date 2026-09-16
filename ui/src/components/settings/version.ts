export type DesktopVersionCheckResult = {
  mode: "desktop" | "web";
  hasUpdate: boolean;
  checkUnavailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  latestPublishedAt: string | null;
  buildTime: string | null;
  canUpdate?: boolean;
  canDownload?: boolean;
  desktopReason?: string | null;
  webReason?: string | null;
  latestSourceSha?: string | null;
};

export function normalizeDesktopVersionResult(payload: any): DesktopVersionCheckResult {
  return {
    mode: "desktop",
    hasUpdate: Boolean(payload?.hasUpdate),
    checkUnavailable: Boolean(payload?.checkUnavailable),
    currentVersion: payload?.current?.version ?? "unknown",
    latestVersion: payload?.latest?.version ?? null,
    canDownload: payload?.canDownload === true,
    desktopReason: payload?.reason ?? null,
    latestPublishedAt: payload?.latest?.publishedAt ?? null,
    buildTime: payload?.current?.buildTime ?? null,
  };
}

export function normalizeWebVersionResult(payload: any): DesktopVersionCheckResult {
  return {
    mode: "web",
    hasUpdate: Boolean(payload?.hasUpdate),
    checkUnavailable: Boolean(payload?.checkUnavailable),
    currentVersion: payload?.current?.tagName || payload?.current?.sourceSha?.slice(0, 8) || "unknown",
    latestVersion: payload?.latest?.tagName ?? null,
    latestPublishedAt: payload?.latest?.publishedAt ?? null,
    buildTime: payload?.current?.buildTime ?? null,
    canUpdate: payload?.canUpdate === true,
    webReason: payload?.reason ?? null,
    latestSourceSha: payload?.latest?.sourceSha ?? null,
  };
}
