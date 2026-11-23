import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  zInt,
  zNum,
  zPlayerRef,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { PathFinding } from "../pathfinding/PathFinder";
import { PathStatus, SteppingPathFinder } from "../pathfinding/types";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import {
  AirPathFinderSchema,
  airPathFinderState,
  restoreAirPathFinder,
} from "../snapshot/PathfinderSnapshots";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * One-shot air raid from the nearest city to a clicked tile. Damages/destroys
 * enemy structures in a small blast (weaker than an Atom Bomb); does not
 * convert land to water or wipe troop blobs.
 */
export class BomberExecution implements Execution {
  private active = true;
  private mg: Game;
  private bomber: Unit | null = null;
  private pathFinder: SteppingPathFinder<TileRef>;
  private speed = 6;
  private src: TileRef | null = null;

  constructor(
    private player: Player,
    private dst: TileRef,
  ) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    this.speed = mg.config().nukeSpeed(UnitType.Bomber);
    this.pathFinder = PathFinding.Air(mg);
  }

  tick(_ticks: number): void {
    if (this.bomber === null) {
      const spawn = this.player.canBuild(UnitType.Bomber, this.dst);
      if (spawn === false) {
        console.warn("cannot build Bomber");
        this.active = false;
        return;
      }
      this.src = spawn;
      this.bomber = this.player.buildUnit(UnitType.Bomber, this.src, {
        targetTile: this.dst,
      });

      if (this.mg.hasOwner(this.dst)) {
        const target = this.mg.owner(this.dst);
        if (target.isPlayer()) {
          this.mg.displayIncomingUnit(
            this.bomber.id(),
            "events_display.bomber_inbound",
            MessageType.NUKE_INBOUND,
            target.id(),
          );
        }
      }
      return;
    }

    if (!this.bomber.isActive()) {
      this.active = false;
      return;
    }

    for (let i = 0; i < this.speed; i++) {
      const result = this.pathFinder.next(this.bomber.tile(), this.dst);
      if (result.status === PathStatus.COMPLETE) {
        this.bomber.move(result.node);
        this.bomb();
        return;
      }
      if (result.status === PathStatus.NEXT) {
        this.bomber.move(result.node);
      } else {
        // No path — abort without refund (gold already spent on build).
        this.bomber.delete(false);
        this.active = false;
        return;
      }
    }
  }

  private bomb() {
    if (this.bomber === null) {
      throw new Error("Not initialized");
    }
    const magnitude = this.mg.config().nukeMagnitudes(UnitType.Bomber);
    const outer2 = magnitude.outer * magnitude.outer;
    const inner2 = magnitude.inner * magnitude.inner;
    const dst = this.dst;

    for (const unit of this.mg.units(Structures.types)) {
      if (!unit.isActive()) continue;
      if (this.player.isFriendly(unit.owner(), true)) continue;
      const dist2 = this.mg.euclideanDistSquared(dst, unit.tile());
      if (dist2 >= outer2) continue;
      if (dist2 < inner2) {
        unit.delete(true, this.player);
      } else {
        // Outer ring: one level of damage via health if the unit has it,
        // otherwise delete smaller structures.
        if (unit.hasHealth()) {
          unit.modifyHealth(-500, this.player);
        } else {
          unit.delete(true, this.player);
        }
      }
    }

    this.active = false;
    this.bomber.setReachedTarget();
    this.bomber.delete(false);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return BomberExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      dst: this.dst,
      speed: this.speed,
      src: this.src,
      bomber: w.unitOrNull(this.bomber),
      pathFinder:
        this.pathFinder !== undefined
          ? airPathFinderState(this.pathFinder)
          : null,
    });
  }

  restoreSnapshot(s: BomberState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.dst = s.dst;
    this.speed = s.speed;
    this.src = s.src;
    this.bomber = r.unitOrNull(s.bomber);
    if (s.pathFinder) {
      this.pathFinder = restoreAirPathFinder(r.game, s.pathFinder);
    }
  }
}

const BomberStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  dst: zTile(),
  speed: zNum(),
  src: zTile().nullable(),
  bomber: zRef().nullable(),
  pathFinder: AirPathFinderSchema.nullable(),
});
type BomberState = z.infer<typeof BomberStateSchema>;

export const BomberExecutionSnapshot = execSnapshotType({
  name: "Bomber",
  version: 1,
  schema: BomberStateSchema,
  cls: () => BomberExecution,
});
