import { zRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * Cheap land structure. Gold payout is applied in EngineConfig.goldAdditionRate
 * (counts active mines); this execution only tracks lifetime.
 */
export class MineExecution implements Execution {
  private mg: Game;
  private active = true;

  constructor(private mine: Unit) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
  }

  tick(_ticks: number): void {
    if (!this.mine.isActive()) {
      this.active = false;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return MineExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      mine: w.unit(this.mine),
    });
  }

  restoreSnapshot(s: MineState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.mine = r.unit(s.mine);
  }
}

const MineStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  mine: zRef(),
});
type MineState = z.infer<typeof MineStateSchema>;

export const MineExecutionSnapshot = execSnapshotType({
  name: "Mine",
  version: 1,
  schema: MineStateSchema,
  cls: () => MineExecution,
});
