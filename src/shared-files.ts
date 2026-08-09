import type { SharedMeetingState, Contribution, Interjection } from "./types.js";

type FileOps = {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  write(path: string, data: string): Promise<void>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  _clearPrefix?(prefix: string): Promise<void>;
};

async function getBunOps(): Promise<FileOps | null> {
  try {
    const bun = (globalThis as any).Bun;
    if (!bun) return null;
    return {
      mkdir: (p, opts) => bun.fs.mkdir(p, opts),
      write: (p, d) => bun.write(p, d),
      read: async (p) => {
        const f = bun.file(p);
        return await f.text();
      },
      exists: (p) => bun.fs.exists(p),
      unlink: (p) => bun.fs.unlink(p),
      readdir: (p) => bun.fs.readdir(p),
    };
  } catch {
    return null;
  }
}

const memFs = new Map<string, string>();

function getMemOps(): FileOps {
  return {
    mkdir: async () => {},
    write: async (p, d) => { memFs.set(p, d); },
    read: async (p) => {
      const v = memFs.get(p);
      if (v === undefined) throw new Error(`not found: ${p}`);
      return v;
    },
    exists: async (p) => memFs.has(p),
    unlink: async (p) => { memFs.delete(p); },
    readdir: async (dir: string): Promise<string[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const entries = new Set<string>();
      for (const key of memFs.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const parts = rest.split("/");
          if (parts[0]) entries.add(parts[0]);
        }
      }
      return [...entries];
    },
    _clearPrefix: async (prefix: string) => {
      const keysToDelete = [];
      for (const key of memFs.keys()) {
        if (key.startsWith(prefix)) keysToDelete.push(key);
      }
      for (const key of keysToDelete) memFs.delete(key);
    },
  };
}

let ops: FileOps | null = null;

async function fs(): Promise<FileOps> {
  if (ops) return ops;
  ops = await getBunOps();
  if (!ops) ops = getMemOps();
  return ops;
}

/** Resets the in-memory filesystem (for testing). */
export function _resetMemFs(): void {
  memFs.clear();
  ops = null;
}

function meetingDir(meetingId: string): string {
  return `.opencode/loom/meetings/${meetingId}`;
}

function sharedDir(meetingId: string): string {
  return `.opencode/loom/meetings/${meetingId}/shared`;
}

function agentDir(meetingId: string, agentId: string): string {
  return `.opencode/loom/meetings/${meetingId}/agents/${agentId}`;
}

/** Initializes the directory structure for a new meeting. */
export async function initMeetingFiles(meetingId: string): Promise<void> {
  const f = await fs();
  await f.mkdir(sharedDir(meetingId), { recursive: true });
  await f.mkdir(`${meetingDir(meetingId)}/agents`, { recursive: true });
}

/** Writes the shared meeting state to JSON files. */
export async function writeSharedState(state: SharedMeetingState): Promise<void> {
  const f = await fs();
  const dir = sharedDir(state.meeting_id);
  await f.mkdir(dir, { recursive: true });
  await f.write(`${dir}/state.json`, JSON.stringify(state, null, 2));
  await f.write(`${dir}/round.txt`, String(state.round));
  await f.write(`${dir}/warp.md`, state.warp);
}

/** Reads the shared meeting state from JSON files. Returns null if not found. */
export async function readSharedState(meetingId: string): Promise<SharedMeetingState | null> {
  try {
    const f = await fs();
    const data = await f.read(`${sharedDir(meetingId)}/state.json`);
    return JSON.parse(data) as SharedMeetingState;
  } catch {
    return null;
  }
}

/** Reads the shared context (warp) from a markdown file. */
export async function readWarp(meetingId: string): Promise<string> {
  try {
    const f = await fs();
    return await f.read(`${sharedDir(meetingId)}/warp.md`);
  } catch {
    return "";
  }
}

/** Writes the shared context (warp) to a markdown file. */
export async function writeWarp(meetingId: string, warp: string): Promise<void> {
  const f = await fs();
  await f.write(`${sharedDir(meetingId)}/warp.md`, warp);
}

export async function readRound(meetingId: string): Promise<number> {
  try {
    const f = await fs();
    const data = await f.read(`${sharedDir(meetingId)}/round.txt`);
    return parseInt(data.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/** Writes the current round number to a file. */
export async function writeRound(meetingId: string, round: number): Promise<void> {
  const f = await fs();
  await f.write(`${sharedDir(meetingId)}/round.txt`, String(round));
}

/** Reads all contributions from the shared contributions file. */
export async function readContributions(meetingId: string): Promise<Contribution[]> {
  try {
    const f = await fs();
    const data = await f.read(`${sharedDir(meetingId)}/contributions.json`);
    return JSON.parse(data) as Contribution[];
  } catch {
    return [];
  }
}

export async function writeContributions(meetingId: string, contributions: Contribution[]): Promise<void> {
  const f = await fs();
  await f.write(`${sharedDir(meetingId)}/contributions.json`, JSON.stringify(contributions, null, 2));
}

/** Appends a contribution to the shared contributions file. */
export async function addContribution(meetingId: string, contribution: Contribution): Promise<void> {
  const existing = await readContributions(meetingId);
  existing.push(contribution);
  await writeContributions(meetingId, existing);
}

export async function readInterjections(meetingId: string): Promise<Interjection[]> {
  try {
    const f = await fs();
    const data = await f.read(`${sharedDir(meetingId)}/interjections.json`);
    return JSON.parse(data) as Interjection[];
  } catch {
    return [];
  }
}

export async function writeInterjections(meetingId: string, interjections: Interjection[]): Promise<void> {
  const f = await fs();
  await f.write(`${sharedDir(meetingId)}/interjections.json`, JSON.stringify(interjections, null, 2));
}

/** Appends an interjection to the shared interjections file. */
export async function addInterjection(meetingId: string, interjection: Interjection): Promise<void> {
  const existing = await readInterjections(meetingId);
  existing.push(interjection);
  await writeInterjections(meetingId, existing);
}

/** Initializes the directory for a specific agent's output files. */
export async function initAgentDir(meetingId: string, agentId: string): Promise<void> {
  const f = await fs();
  await f.mkdir(agentDir(meetingId, agentId), { recursive: true });
}

/** Writes an agent's response to their designated output file. */
export async function writeAgentResponse(meetingId: string, agentId: string, response: string): Promise<void> {
  const f = await fs();
  await f.write(`${agentDir(meetingId, agentId)}/response.md`, response);
}

export async function readAgentResponse(meetingId: string, agentId: string): Promise<string | null> {
  try {
    const f = await fs();
    return await f.read(`${agentDir(meetingId, agentId)}/response.md`);
  } catch {
    return null;
  }
}

export async function hasAgentResponded(meetingId: string, agentId: string): Promise<boolean> {
  const f = await fs();
  return f.exists(`${agentDir(meetingId, agentId)}/response.md`);
}

export async function clearAgentResponse(meetingId: string, agentId: string): Promise<void> {
  try {
    const f = await fs();
    await f.unlink(`${agentDir(meetingId, agentId)}/response.md`);
  } catch {
  }
}

export async function cleanupMeeting(meetingId: string): Promise<void> {
  try {
    const dir = meetingDir(meetingId);
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const f = await fs();

    if ("_clearPrefix" in (f as any)) {
      await (f as any)._clearPrefix(prefix);
    } else {
      try {
        const entries = await f.readdir(dir);
        for (const entry of entries) {
          const path = `${dir}/${entry}`;
          try {
            const subEntries = await f.readdir(path);
            for (const sub of subEntries) {
              await f.unlink(`${path}/${sub}`).catch(() => {});
            }
          } catch {
            await f.unlink(path).catch(() => {});
          }
        }
      } catch {
      }
    }
  } catch {
  }
}

export { sharedDir, agentDir, meetingDir };
