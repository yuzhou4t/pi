import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { projectWorkError } from "./errors.js";

const execFileAsync = promisify(execFile);

export function createMacOSProjectPicker({
  platform = process.platform,
  execute = execFileAsync,
} = {}) {
  return async function pickProjectRoot({ mode = "existing" } = {}) {
    if (platform !== "darwin") {
      throw projectWorkError(
        "PROJECT_WORK_PICKER_UNAVAILABLE",
        "本地文件夹选择器当前仅支持 macOS",
        501,
      );
    }
    const prompt = mode === "create"
      ? "选择新项目文件夹的保存位置"
      : "选择要绑定的本地项目文件夹";
    try {
      const { stdout } = await execute(
        "/usr/bin/osascript",
        [
          "-e",
          `POSIX path of (choose folder with prompt "${prompt}")`,
        ],
        {
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 16 * 1024,
        },
      );
      const selectedPath = String(stdout ?? "").trim().replace(/\/$/, "");
      if (!selectedPath) {
        throw projectWorkError(
          "PROJECT_WORK_PICK_RESULT_INVALID",
          "文件夹选择器没有返回有效结果",
          500,
        );
      }
      return mode === "create"
        ? { parentPath: selectedPath }
        : { rootPath: selectedPath };
    } catch (error) {
      if (
        error?.code === "PROJECT_WORK_PICK_RESULT_INVALID"
        || error?.code === "PROJECT_WORK_PICKER_UNAVAILABLE"
      ) {
        throw error;
      }
      if (
        error?.code === 1
        && /(?:User canceled|-128)/i.test(String(error.stderr ?? error.message ?? ""))
      ) {
        throw projectWorkError(
          "PROJECT_WORK_PICKER_CANCELLED",
          "已取消选择本地文件夹",
          409,
        );
      }
      throw projectWorkError(
        "PROJECT_WORK_PICKER_FAILED",
        "无法打开本地文件夹选择器",
        500,
        true,
      );
    }
  };
}
