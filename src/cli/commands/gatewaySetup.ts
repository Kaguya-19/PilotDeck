import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const PILOTDECK_YAML_PATH = join(homedir(), ".pilotdeck", "pilotdeck.yaml");
const WEIXIN_CREDS_PATH = join(homedir(), ".pilotdeck", "weixin-credentials.json");

const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const LARK_TOKEN_URL = "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal";

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runGatewaySetup(argv: string[]): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║  PilotDeck Gateway Setup                        ║");
    console.log("║  配置 IM 平台连接                                ║");
    console.log("╚══════════════════════════════════════════════════╝\n");

    const platform = argv[0]?.toLowerCase();
    if (platform === "feishu" || platform === "lark") {
      await setupFeishu(rl);
    } else if (platform === "weixin" || platform === "wechat") {
      await setupWeixin(rl);
    } else {
      const choice = await selectPlatform(rl);
      if (choice === "feishu") await setupFeishu(rl);
      else if (choice === "weixin") await setupWeixin(rl);
      else if (choice === "all") {
        await setupFeishu(rl);
        console.log("");
        await setupWeixin(rl);
      } else {
        console.log("未选择任何平台，退出。");
      }
    }
  } finally {
    rl.close();
  }
}

async function selectPlatform(
  rl: ReturnType<typeof createInterface>,
): Promise<"feishu" | "weixin" | "all" | null> {
  const currentConfig = loadYamlConfig();
  const feishuStatus = currentConfig?.adapters?.feishu?.enabled ? "✅ 已启用" : "未配置";
  const weixinStatus = existsSync(WEIXIN_CREDS_PATH) ? "✅ 已有凭据" : "未配置";

  console.log("可配置的平台：");
  console.log(`  1) 飞书 / Lark      [${feishuStatus}]`);
  console.log(`  2) 微信 (iLink)     [${weixinStatus}]`);
  console.log(`  3) 全部配置`);
  console.log(`  q) 退出\n`);

  const answer = (await rl.question("请选择 [1/2/3/q]: ")).trim().toLowerCase();
  if (answer === "1" || answer === "feishu") return "feishu";
  if (answer === "2" || answer === "weixin") return "weixin";
  if (answer === "3" || answer === "all") return "all";
  return null;
}

// ---------------------------------------------------------------------------
// Feishu Setup
// ---------------------------------------------------------------------------

async function setupFeishu(rl: ReturnType<typeof createInterface>): Promise<void> {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  飞书 / Lark 配置");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const currentConfig = loadYamlConfig();
  const currentAppId = currentConfig?.adapters?.feishu?.appId || "";
  const currentSecret = currentConfig?.adapters?.feishu?.appSecret || "";
  const currentDomain = currentConfig?.adapters?.feishu?.domainName || "feishu";

  // Domain selection
  const domainAnswer = (
    await rl.question(
      `使用哪个平台？ [feishu/lark] (当前: ${currentDomain}): `,
    )
  ).trim().toLowerCase();
  const domain: "feishu" | "lark" =
    domainAnswer === "lark" ? "lark" : "feishu";

  const consoleUrl =
    domain === "lark"
      ? "https://open.larksuite.com"
      : "https://open.feishu.cn";

  // Check if we can do QR-scan app creation via the Lark SDK
  const qrResult = await attemptFeishuQRCreation(rl, domain);
  let appId: string;
  let appSecret: string;

  if (qrResult) {
    appId = qrResult.appId;
    appSecret = qrResult.appSecret;
  } else {
    // Manual credential entry
    console.log(`\n请在 ${consoleUrl} 创建企业自建应用：`);
    console.log("  1. 创建应用 → 获取 App ID 和 App Secret");
    console.log("  2. 权限管理 → 添加以下权限：");
    console.log("     - im:message (收发消息)");
    console.log("     - im:message:send_as_bot (以机器人身份发消息)");
    console.log("     - im:resource (访问图片/文件)");
    console.log("     - im:chat (群聊元信息)");
    console.log("  3. 事件订阅 → 添加 im.message.receive_v1");
    console.log("  4. 版本管理 → 发布版本\n");

    const defaultAppIdHint = currentAppId ? ` (当前: ${maskSecret(currentAppId)})` : "";
    appId = (
      await rl.question(`App ID${defaultAppIdHint}: `)
    ).trim() || currentAppId;

    const defaultSecretHint = currentSecret ? " (回车保留当前值)" : "";
    const secretInput = (
      await rl.question(`App Secret${defaultSecretHint}: `)
    ).trim();
    appSecret = secretInput || currentSecret;
  }

  if (!appId || !appSecret) {
    console.log("\n⚠️  未提供完整凭据，跳过飞书配置。");
    return;
  }

  // Test connection
  console.log("\n🔍 验证凭据...");
  const tokenUrl = domain === "lark" ? LARK_TOKEN_URL : FEISHU_TOKEN_URL;
  const testResult = await testFeishuCredentials(appId, appSecret, tokenUrl);

  if (!testResult.ok) {
    console.log(`\n❌ 凭据验证失败: ${testResult.error}`);
    const proceed = (await rl.question("是否仍然保存配置？ [y/N]: ")).trim().toLowerCase();
    if (proceed !== "y" && proceed !== "yes") {
      console.log("已取消。");
      return;
    }
  } else {
    console.log("✅ 凭据验证通过！");
  }

  // Write config
  writeFeishuConfig({ appId, appSecret, domain });
  console.log("\n✅ 飞书配置已写入 pilotdeck.yaml");
  console.log("   连接模式: stream (WebSocket, 推荐 — 无需公网 IP)");
  console.log("   重启 PilotDeck 服务后生效\n");
}

async function attemptFeishuQRCreation(
  rl: ReturnType<typeof createInterface>,
  domain: "feishu" | "lark",
): Promise<{ appId: string; appSecret: string } | null> {
  let Lark: any;
  try {
    const mod = await import("@larksuiteoapi/node-sdk");
    Lark = (mod as { default?: unknown }).default ?? mod;
  } catch {
    return null;
  }

  if (!Lark?.AppTicketManager) return null;

  const answer = (
    await rl.question(
      "是否尝试扫码自动创建飞书应用？(需要管理员权限) [y/N]: ",
    )
  ).trim().toLowerCase();

  if (answer !== "y" && answer !== "yes") return null;

  try {
    console.log("\n正在生成二维码...");
    const larkDomain =
      domain === "lark"
        ? Lark.Domain?.Lark ?? "https://open.larksuite.com"
        : Lark.Domain?.Feishu ?? "https://open.feishu.cn";

    const createAppUrl = `${larkDomain}/open-apis/authen/v1/app_access_token`;
    console.log(`\n请在浏览器中访问以下链接，使用飞书扫码授权：`);
    console.log(`  ${larkDomain}/app\n`);
    console.log("创建应用后，将 App ID 和 App Secret 粘贴到下方。\n");

    return null;
  } catch (e) {
    console.log(`\n自动创建失败: ${e instanceof Error ? e.message : String(e)}`);
    console.log("将使用手动输入模式。\n");
    return null;
  }
}

async function testFeishuCredentials(
  appId: string,
  appSecret: string,
  tokenUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const json = (await res.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
    };

    if (json.code === 0 && json.tenant_access_token) {
      return { ok: true };
    }
    return {
      ok: false,
      error: `code=${json.code} msg=${json.msg ?? "unknown"}`,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function writeFeishuConfig(cfg: {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
}): void {
  const yamlConfig = loadYamlConfig() ?? {};

  if (!yamlConfig.adapters) yamlConfig.adapters = {};
  yamlConfig.adapters.feishu = {
    enabled: true,
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    connectionMode: "stream",
    domainName: cfg.domain,
  };

  saveYamlConfig(yamlConfig);
}

// ---------------------------------------------------------------------------
// Weixin (iLink) Setup
// ---------------------------------------------------------------------------

async function setupWeixin(rl: ReturnType<typeof createInterface>): Promise<void> {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  微信 iLink 配置");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const existingCreds = loadWeixinCredentials();
  if (existingCreds) {
    console.log(`已有凭据 (accountId: ${existingCreds.accountId})`);
    const answer = (await rl.question("重新登录？ [y/N]: ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      // Make sure weixin is enabled in config
      enableWeixinConfig();
      console.log("✅ 微信已启用（使用现有凭据）\n");
      return;
    }
  }

  console.log("⚠️  注意：");
  console.log("  - 使用 iLink Bot API，非企业微信");
  console.log("  - 建议使用小号登录，有封号风险");
  console.log("  - 群聊功能默认禁用\n");

  const proceed = (await rl.question("继续扫码登录？ [Y/n]: ")).trim().toLowerCase();
  if (proceed === "n" || proceed === "no") {
    console.log("已取消。");
    return;
  }

  let loginWithQR: typeof import("weixin-ilink").loginWithQR;
  try {
    const mod = await import("weixin-ilink");
    loginWithQR = mod.loginWithQR;
  } catch (e) {
    console.log("\n❌ weixin-ilink 模块加载失败");
    console.log("   请运行: npm install weixin-ilink\n");
    return;
  }

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  请用微信扫描二维码                          ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  try {
    const result = await loginWithQR({
      onQRCode: (url: string) => {
        console.log("扫码登录链接：");
        console.log(`  ${url}\n`);
        console.log("如果终端无法显示二维码，请在浏览器中打开上述链接。\n");
      },
      onStatusChange: (status: string) => {
        const labels: Record<string, string> = {
          waiting: "⏳ 等待扫码...",
          scanned: "📱 已扫码，等待确认...",
          expired: "⏰ 二维码已过期，正在刷新...",
          refreshing: "🔄 刷新中...",
        };
        console.log(labels[status] ?? `状态: ${status}`);
      },
    });

    const creds = {
      baseUrl: result.baseUrl,
      botToken: result.botToken,
      accountId: result.accountId,
    };

    saveWeixinCredentials(creds);
    enableWeixinConfig();

    console.log(`\n✅ 微信登录成功！`);
    console.log(`   账号 ID: ${result.accountId}`);
    console.log(`   凭据已保存到: ${WEIXIN_CREDS_PATH}`);
    console.log(`   重启 PilotDeck 服务后生效\n`);
  } catch (e) {
    console.log(`\n❌ 微信登录失败: ${e instanceof Error ? e.message : String(e)}`);
    console.log("   请检查网络连接后重试。\n");
  }
}

function loadWeixinCredentials(): { accountId: string; baseUrl: string; botToken: string } | null {
  try {
    if (!existsSync(WEIXIN_CREDS_PATH)) return null;
    const raw = readFileSync(WEIXIN_CREDS_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (!data.baseUrl || !data.botToken || !data.accountId) return null;
    return data;
  } catch {
    return null;
  }
}

function saveWeixinCredentials(creds: {
  baseUrl: string;
  botToken: string;
  accountId: string;
}): void {
  mkdirSync(join(homedir(), ".pilotdeck"), { recursive: true });
  writeFileSync(WEIXIN_CREDS_PATH, JSON.stringify(creds, null, 2), "utf-8");
}

function enableWeixinConfig(): void {
  const yamlConfig = loadYamlConfig() ?? {};
  if (!yamlConfig.adapters) yamlConfig.adapters = {};
  yamlConfig.adapters.weixin = { enabled: true };
  saveYamlConfig(yamlConfig);
}

// ---------------------------------------------------------------------------
// YAML config read/write
// ---------------------------------------------------------------------------

function loadYamlConfig(): Record<string, any> | null {
  try {
    if (!existsSync(PILOTDECK_YAML_PATH)) return null;
    const raw = readFileSync(PILOTDECK_YAML_PATH, "utf-8");
    return parseYaml(raw) as Record<string, any>;
  } catch {
    return null;
  }
}

function saveYamlConfig(config: Record<string, any>): void {
  mkdirSync(join(homedir(), ".pilotdeck"), { recursive: true });
  const yamlStr = stringifyYaml(config, {
    lineWidth: 0,
    singleQuote: false,
  });
  writeFileSync(PILOTDECK_YAML_PATH, yamlStr, "utf-8");
}

function maskSecret(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
