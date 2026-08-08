import type { LoomState } from "./types.js";

declare const Bun: {
  write(path: string, data: string): Promise<void>;
  read(path: string): Promise<string>;
  fs: {
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    exists(path: string): Promise<boolean>;
  };
};

function dirPath(): string {
  return ".opencode/loom";
}

function filePath(id: string): string {
  return `${dirPath()}/${id}.json`;
}

export async function saveState(state: LoomState): Promise<void> {
  try {
    await Bun.fs.mkdir(dirPath(), { recursive: true });
    await Bun.write(filePath(state.id), JSON.stringify(state, null, 2));
  } catch {
  }
}

export async function loadState(id: string): Promise<LoomState | null> {
  try {
    const path = filePath(id);
    if (!(await Bun.fs.exists(path))) return null;
    const data = await Bun.read(path);
    return JSON.parse(data) as LoomState;
  } catch {
    return null;
  }
}

export async function deleteState(id: string): Promise<void> {
  try {
    await Bun.fs.unlink(filePath(id));
  } catch {
  }
}

export interface IncompleteLoom {
  id: string;
  question: string;
  status: string;
  round: number;
  participants: number;
}

export async function listIncompleteLooms(): Promise<IncompleteLoom[]> {
  try {
    const dir = dirPath();
    if (!(await Bun.fs.exists(dir))) return [];

    const files = await Bun.fs.readdir(dir);
    const incomplete: IncompleteLoom[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = await Bun.read(`${dir}/${file}`);
        const state = JSON.parse(data) as LoomState;
        if (state.status !== "converged" && state.status !== "aborted") {
          incomplete.push({
            id: state.id,
            question: state.question,
            status: state.status,
            round: state.current_round,
            participants: state.participants.length,
          });
        }
      } catch {
      }
    }

    return incomplete;
  } catch {
    return [];
  }
}
