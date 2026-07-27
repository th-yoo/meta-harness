// TODO(B): FileStateStore — atomic tmp+rename, corrupt→initial, rate-limited 7d sweep
import type { CcGateState, StateStore } from "./types.ts"
export class FileStateStore implements StateStore {
  constructor(readonly dirAbs: string) {}
  load(sessionId: string): CcGateState { void sessionId; throw new Error("TODO(B)") }
  save(sessionId: string, s: CcGateState): void { void sessionId; void s; throw new Error("TODO(B)") }
  sweep(nowMs: number): void { void nowMs; throw new Error("TODO(B)") }
}
