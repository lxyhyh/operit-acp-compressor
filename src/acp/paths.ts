/**
 * paths.ts — 数据目录与设置/状态/日志文件路径的单一事实来源。
 *
 * 沿用既有插件数据目录（兼容旧版已生成的 acp-config.json / sessions/）：
 *   /sdcard/Download/Operit/plugins/com.operit.acp_compressor/
 */

/** 插件数据根目录。 */
export const DATA_DIR = "/sdcard/Download/Operit/plugins/com.operit.acp_compressor";

/** 设置文件（工具箱设置页 / hook / 工具同源）。沿用旧版 acp-config.json。 */
export const SETTINGS_FILE = `${DATA_DIR}/acp-config.json`;

/** state 目录（persistence 用；与旧 sessions/ 区分，避免混写旧格式）。 */
export const STATE_DIR = `${DATA_DIR}/acp-state`;

/** 日志目录与文件。 */
export const LOG_DIR = `${DATA_DIR}/logs`;
export const LOG_ACP_FILE = `${LOG_DIR}/acp.log`;
export const LOG_TOOLS_VISIBILITY_FILE = `${LOG_DIR}/tools_visibility.log`;
export const LOG_TOOL_CALLS_FILE = `${LOG_DIR}/acp_tool_calls.log`;

let _configDir: string | null = null;

/**
 * 宿主配置目录（ToolPkg.getConfigDir() 动态值；不可用时回退 DATA_DIR）。
 * 由 config.ts 使用（acp-config.json 所在目录）。原实现位于 state.ts（v0.2 遗留），
 * v0.3 抽离至 paths 单一事实来源，使 state.ts 可随遗留孤岛一并移除。
 */
export function resolveConfigDir(): string {
  if (_configDir) return _configDir;
  try {
    const dir =
      typeof ToolPkg !== "undefined" && typeof ToolPkg.getConfigDir === "function"
        ? ToolPkg.getConfigDir()
        : "";
    _configDir = dir || "";
  } catch {
    _configDir = "";
  }
  return _configDir;
}
