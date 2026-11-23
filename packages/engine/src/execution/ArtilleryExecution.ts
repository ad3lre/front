import { CruiseMissileTargets } from "@openfront/engine-api/game/GameTypes";
import { zInt, zRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { findMinimumBy } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { ShellExecution } from "./ShellExecution";

/**
 * Stationary land gun: auto-shells the nearest enemy military structure
 * (defense post / SAM / silo / artillery) in range.
 */
export class ArtilleryExecution implements Execution {
  private mg: Game;
  private active = true;
  private target: Unit | null = null;
  private lastShellAttack = 0;
  private alreadySentShell = new Set<Unit>();

  constructor(private artillery: Unit) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
  }

  tick(_ticks: number): void {
    if (!this.artillery.isActive()) {
      this.active = false;
      return;
    }
    if (
      this.artillery.isUnderConstruction() ||
      this.artillery.isCruiseDisabled()
    ) {
      return;
    }

    if (this.target !== null && !this.target.isActive()) {
      this.target = null;
    }

    if (this.target === null) {
      this.target = this.findTarget();
    }

    if (this.target === null) {
      return;
    }

    const rate = this.mg.config().artilleryShellAttackRate();
    if (this.mg.ticks() - this.lastShellAttack > rate) {
      this.lastShellAttack = this.mg.ticks();
      this.mg.addExecution(
        new ShellExecution(
          this.artillery.tile(),
          this.artillery.owner(),
          this.artillery,
          this.target,
        ),
      );
      if (!this.target.hasHealth()) {
        this.alreadySentShell.add(this.target);
        this.target = null;
      }
    }
  }

  private findTarget(): Unit | null {
    const owner = this.artillery.owner();
    const range = this.mg.config().artilleryRange();
    const nearby = this.mg.nearbyUnits(
      this.artillery.tile(),
      range,
      CruiseMissileTargets.types,
    );

    const candidates = nearby.filter(({ unit }) => {
      if (!unit.isActive()) return false;
      if (unit.owner() === owner) return false;
      if (owner.isFriendly(unit.owner(), true)) return false;
      if (unit.isUnderConstruction()) return false;
      if (this.alreadySentShell.has(unit)) return false;
      return true;
    });

    if (candidates.length === 0) return null;

    return (
      findMinimumBy(candidates, (c) => c.distSquared)?.unit ?? null
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return ArtilleryExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      artillery: w.unit(this.artillery),
      target: w.unitOrNull(this.target),
      lastShellAttack: this.lastShellAttack,
      alreadySentShell: [...this.alreadySentShell].map((u) => w.unit(u)),
    });
  }

  restoreSnapshot(s: ArtilleryState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.artillery = r.unit(s.artillery);
    this.target = r.unitOrNull(s.target);
    this.lastShellAttack = s.lastShellAttack;
    this.alreadySentShell = new Set(s.alreadySentShell.map((i) => r.unit(i)));
  }
}

const ArtilleryStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  artillery: zRef(),
  target: zRef().nullable(),
  lastShellAttack: zInt(),
  alreadySentShell: z.array(zRef()),
});
type ArtilleryState = z.infer<typeof ArtilleryStateSchema>;

export const ArtilleryExecutionSnapshot = execSnapshotType({
  name: "Artillery",
  version: 1,
  schema: ArtilleryStateSchema,
  cls: () => ArtilleryExecution,
});
