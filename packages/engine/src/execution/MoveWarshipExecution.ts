import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { zNum, zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

export class MoveWarshipExecution implements Execution {
  constructor(
    private owner: Player,
    private unitIds: number[],
    private position: TileRef,
  ) {}

  init(mg: Game, _ticks: number): void {
    if (!mg.isValidRef(this.position)) {
      console.warn(`MoveWarshipExecution: position ${this.position} not valid`);
      return;
    }
    // Get water component of new TargetTile for connectivity check
    const newPatrolTileWaterComponent = mg.getWaterComponent(this.position);
    // Cache warship + submarine list and build a lookup map
    const navalMap = new Map(
      [
        ...this.owner.units(UnitType.Warship),
        ...this.owner.units(UnitType.Submarine),
      ].map((u) => [u.id(), u]),
    );
    // Deduplicate ids so each vessel is only moved once
    for (const unitId of new Set(this.unitIds)) {
      const warship = navalMap.get(unitId);
      if (!warship) {
        console.warn(`MoveWarshipExecution: naval unit ${unitId} not found`);
        continue;
      }
      if (!warship.isActive()) {
        console.warn(
          `MoveWarshipExecution: naval unit ${unitId} is not active`,
        );
        continue;
      }
      // Do not update the patrolTile if it is in a different Water Component
      if (!mg.hasWaterComponent(warship.tile(), newPatrolTileWaterComponent!)) {
        continue;
      }
      warship.updateWarshipState({
        patrolTile: this.position,
      });
      warship.setTargetTile(undefined);
    }
  }

  tick(_ticks: number): void {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return MoveWarshipExecutionSnapshot.write({
      owner: w.player(this.owner),
      unitIds: [...this.unitIds],
      position: this.position,
    });
  }

  restoreSnapshot(s: MoveWarshipState, r: SnapshotReader): void {
    this.owner = r.player(s.owner);
    this.unitIds = s.unitIds;
    this.position = s.position;
  }
}

// position is untrusted intent data (validated in init), so any number.
const MoveWarshipStateSchema = z.object({
  owner: zPlayerRef(),
  unitIds: z.array(zNum()),
  position: zNum(),
});
type MoveWarshipState = z.infer<typeof MoveWarshipStateSchema>;

export const MoveWarshipExecutionSnapshot = execSnapshotType({
  name: "MoveWarship",
  version: 1,
  schema: MoveWarshipStateSchema,
  cls: () => MoveWarshipExecution,
});
