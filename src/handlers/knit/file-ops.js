import { unlinkSync, writeFileSync, mkdirSync, openSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { join } from "node:path";
import { resolveLoomBaseDir } from "../../paths.js";
import { extractErrorInfo } from "../../logger.js";

export function writeReportFile(directory, meetingId, report, logger) {
  const tmpSuffix = `${process.pid}.${crypto.randomUUID().slice(0, 8)}`;
  let tmpPath = null;
  try {
    const baseDir = resolveLoomBaseDir(directory);
    const dir = join(baseDir, "meetings");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${meetingId}.md`);
    tmpPath = `${filePath}.tmp.${tmpSuffix}`;
    writeFileSync(tmpPath, report, "utf-8");
    try {
      const fd = openSync(tmpPath, "r+");
      fsyncSync(fd);
      closeSync(fd);
    } catch {}
    renameSync(tmpPath, filePath);
    return filePath;
  } catch (err) {
    const info = extractErrorInfo(err);
    logger.warn("report_write_failed", "Failed to write deliberation report file", info);
    if (tmpPath) try { unlinkSync(tmpPath); } catch {}
    return null;
  }
}

export function createSessionLock() {
  const sessionLocks = new Map();
  async function withSessionLock(sessionId, fn) {
    const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
    let release;
    const next = new Promise((res) => { release = res; });
    sessionLocks.set(sessionId, prev.then(() => next));
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (sessionLocks.get(sessionId) === next) sessionLocks.delete(sessionId);
    }
  }
  return withSessionLock;
}
