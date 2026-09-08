/**
 * acp/host-usage-adapter.ts — V0.7.1 HostUsageAdapter（宿主侧 token 测量适配层）。
 *
 * 依据建议文档第 5 阶段：pressure → UsageManager → HostUsageAdapter → Operit 实现。
 * 要求：
 * - ACP 核心与具体实现解耦（核心只依赖接口）。
 * - 数据源优先级：正式 ToolPkg/Host API → hook/runtime payload → Operit DB fallback。
 * - DB fallback 必须：只读、按 chatId 定位、WAL 兼容、失败返回 undefined、
 *   绝不因 DB 不可读拖垮 Agent 请求、记录失败、不缓存过期值作为永久 truth。
 *
 * 当前宿主（审计 TOKEN-SOURCE-AUDIT）：
 * - ChatInfo 无 currentWindowSize；hook payload 无 usage；
 * - 但宿主 sandbox 提供 system.shell / android.executeShell，
 *   可只读 SQLite 读取 chats.currentWindowSize（Operit 右上角那个计数）。
 */

export interface HostUsageAdapter {
  /**
   * 读取某 chat 当前的 host context token（宿主 tokenizer 口径，含已投影窗口）。
   * 失败 / 不可用时返回 undefined，绝不抛异常。
   */
  getCurrentContextTokens(chatId: string): Promise<number | undefined>;
}

/**
 * 创建 HostUsageAdapter 的工厂。
 * env.exec 是可选的命令执行函数（默认尝试全局 Tools）。
 * 返回的 adapter 内部会做失败兜底、超时与缓存节流。
 */
export function createOperitHostUsageAdapter(
  opts?: {
    /** 覆盖命令执行器（如 Tools.system.shell / Tools.android.executeShell）。 */
    exec?: (command: string) => Promise<string | undefined>;
    /** 同一 chat 的读取节流 ms（DB 读取有成本，默认 5s）。 */
    throttleMs?: number;
    maxCacheAgeMs?: number;
  },
): HostUsageAdapter {
  const execFn =
    opts?.exec ??
    (async (command: string) => {
      // 运行时环境可能提供 Tools（system.shell / android.executeShell）。
      const g = globalThis as Record<string, unknown>;
      const tools = (g as { Tools?: Record<string, unknown> }).Tools;
      const system = tools?.system as { shell?: (cmd: string) => Promise<unknown> } | undefined;
      const run = system?.shell ?? (g as { executeShell?: (cmd: string) => Promise<unknown> }).executeShell;
      if (typeof run !== "function") return undefined;
      try {
        const r = (await run(command)) as unknown;
        if (r && typeof r === "object" && "output" in (r as object)) {
          return String((r as { output: unknown }).output ?? "");
        }
        return typeof r === "string" ? r : r === undefined ? undefined : String(r);
      } catch {
        return undefined;
      }
    });

  const throttleMs = opts?.throttleMs ?? 5000;
  // 缓存仅用于节流，不作为长期 truth；超过 maxCacheAge 必重新读。
  const maxCacheAgeMs = opts?.maxCacheAgeMs ?? 30_000;
  const cache = new Map<string, { value?: number; at: number; fail: boolean }>();
  // V0.7.5：不再永久 disabled。一次失败只进入短退避（retryAfterMs），
  // 超过退避窗口后重新尝试；连续失败会指数退避但封顶，避免每轮都打 DB。
  // （文档十三：transient failure 可恢复、保持 throttle、保持 maxCacheAge，
  //   不把一次失败变成整个进程生命周期的永久 disabled。）
  let sqliteOk: boolean | undefined;
  let retryAfterMs = 0;
  let failCount = 0;
  const INITIAL_RETRY_MS = 10_000;
  const MAX_RETRY_MS = 120_000;

  const dbPath = "/data/user/0/com.ai.assistance.operit/databases/app_database";

  // 单条 python3 只读命令：读指定 chatId 的 currentWindowSize；失败输出空。
  const buildCmd = (chatId: string): string =>
    `python3 -c "import sqlite3;" && ` +
    `python3 -c "import sqlite3,json,sys;` +
    `c=sqlite3.connect('file:${dbPath}?mode=ro',uri=True);` +
    `r=c.execute('SELECT currentWindowSize FROM chats WHERE id=?',('${chatId}',)).fetchone();` +
    `print(int(r[0]) if r and r[0] is not None else '')" 2>/dev/null` +
    ` || python3 -c "import sqlite3;` +
    `c=sqlite3.connect('${dbPath}');` +
    `r=c.execute('SELECT currentWindowSize FROM chats WHERE id=?',('${chatId}',)).fetchone();` +
    `print(int(r[0]) if r and r[0] is not None else '')" 2>/dev/null`;

  return {
    async getCurrentContextTokens(chatId): Promise<number | undefined> {
      if (!chatId) return undefined;
      const now = Date.now();
      const hit = cache.get(chatId);
      if (hit && now - hit.at < Math.min(throttleMs, maxCacheAgeMs)) {
        return hit.fail ? undefined : hit.value;
      }
      // V0.7.5：失败退避而非永久 disabled。退避窗口内快速失败，窗口外重试。
      if (sqliteOk === false && now < retryAfterMs) return undefined;

      const start = Date.now();
      const got = await Promise.race([
        execFn(buildCmd(chatId)).catch(() => undefined),
        new Promise<undefined>((res) => setTimeout(() => res(undefined), 1500)),
      ]);
      const took = Date.now() - start;

      let value: number | undefined;
      if (typeof got === "string" && got.trim().length > 0) {
        const n = Number(got.trim());
        if (Number.isFinite(n) && n > 0) value = n;
      }
      cache.set(chatId, { value, at: now, fail: value === undefined });
      if (value === undefined) {
        // 记录失败 + 指数退避（封顶 2 分钟），窗口过后重新尝试（可恢复）。
        failCount++;
        sqliteOk = false;
        retryAfterMs = now + Math.min(INITIAL_RETRY_MS * Math.pow(2, failCount - 1), MAX_RETRY_MS);
      } else {
        failCount = 0;
        sqliteOk = true;
        retryAfterMs = 0;
      }
      return value;
    },
  };
}