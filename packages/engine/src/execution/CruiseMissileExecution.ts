import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  CruiseMissileTargets,
  MessageType,
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
import { Execution, Game, isUnit, Player, Unit } from "../game/Game";
import { UniversalPathFinding } from "../pathfinding/PathFinder";
import { ParabolaUniversalPathFinder } from "../pathfinding/PathFinder.Parabola";
import { PathStatus } from "../pathfinding/types";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import {
  ParabolaSchema,
  parabolaState,
  restoreParabola,
} from "../snapshot/PathfinderSnapshots";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * Tactical missile: flies from the nearest silo to a target tile. On impact,
 * disables CruiseMissileTargets (SAM / silo / defense post / artillery) on the
 * first hit and destroys them on the second. SAMs can intercept in flight.
 */
export class CruiseMissileExecution implements Execution {
  private active = true;
  private mg: Game;
  private missile: Unit | null = null;
  private pathFinder: ParabolaUniversalPathFinder;
  private speed = -1;
  private waitTicks = 0;
  private src: TileRef | null = null;

  constructor(
    private player: Player,
    private dst: TileRef,
    private rocketDirectionUp: boolean = true,
  ) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    this.speed = mg.config().nukeSpeed(UnitType.CruiseMissile);
    this.pathFinder = UniversalPathFinding.Parabola(mg, {
      increment: this.speed,
      directionUp: this.rocketDirectionUp,
    });
  }

  tick(ticks: number): void {
    if (this.missile === null) {
      const spawn = this.player.canBuild(UnitType.CruiseMissile, this.dst);
      if (spawn === false) {
        console.warn("cannot build Cruise Missile");
        this.active = false;
        return;
      }
      this.src = spawn;
      const silo = this.player
        .units(UnitType.MissileSilo)
        .find((s) => s.tile() === spawn);
      if (silo !== undefined) {
        let lastDep = 0;
        for (const launchTick of silo.missileTimerQueue()) {
          lastDep = Math.max(launchTick + 1, lastDep + 1);
        }
        if (lastDep > this.mg.ticks()) {
          this.waitTicks += lastDep - this.mg.ticks();
        }
      }
      this.missile = this.player.buildUnit(UnitType.CruiseMissile, this.src, {
        targetTile: this.dst,
        trajectory: this.getTrajectory(this.dst),
      });
      this.missile.updateNukeState({ waitTicks: this.waitTicks });

      if (this.mg.hasOwner(this.dst)) {
        const target = this.mg.owner(this.dst);
        if (target.isPlayer()) {
          this.mg.displayIncomingUnit(
            this.missile.id(),
            "events_display.cruise_missile_inbound",
            MessageType.NUKE_INBOUND,
            target.id(),
          );
        }
      }
      if (silo) {
        silo.launch();
      }
      return;
    }

    if (!this.missile.isActive()) {
      this.active = false;
      return;
    }

    if (this.waitTicks > 0) {
      this.missile.updateNukeState({ waitTicks: --this.waitTicks });
      return;
    }

    const result = this.pathFinder.next(this.src!, this.dst, this.speed);
    if (result.status === PathStatus.COMPLETE) {
      this.missile.move(result.node);
      const shouldBeDestroyed =
        this.mg.nearbyUnits(
          this.dst,
          this.mg.config().defaultSamMissileSpeed(),
          UnitType.SAMMissile,
          ({ unit }) => {
            if (!isUnit(unit) || unit.owner() === this.missile?.owner()) {
              return false;
            }
            return unit.targetUnit()?.id() === this.missile?.id();
          },
        ).length >= 1;
      if (!shouldBeDestroyed) {
        this.impact();
      }
    } else if (result.status === PathStatus.NEXT) {
      this.missile.move(result.node);
      this.missile.setTrajectoryIndex(this.pathFinder.currentIndex());
      const targetRangeSquared =
        this.mg.config().defaultNukeTargetableRange() ** 2;
      this.missile.setTargetable(
        this.mg.euclideanDistSquared(this.dst, this.missile.tile()) <
          targetRangeSquared ||
          (this.src !== null &&
            this.mg.euclideanDistSquared(this.src, this.missile.tile()) <
              targetRangeSquared),
      );
    }
  }

  private impact() {
    if (this.missile === null) {
      throw new Error("Not initialized");
    }
    const magnitude = this.mg.config().nukeMagnitudes(UnitType.CruiseMissile);
    const outer2 = magnitude.outer * magnitude.outer;
    const dst = this.dst;

    for (const unit of this.mg.units(CruiseMissileTargets.types)) {
      if (!unit.isActive()) continue;
      if (this.mg.euclideanDistSquared(dst, unit.tile()) >= outer2) continue;
      if (this.player.isFriendly(unit.owner(), true)) continue;

      const result = unit.recordCruiseHit();
      if (result === "destroyed") {
        unit.delete(true, this.player);
      }
    }

    this.active = false;
    this.missile.setReachedTarget();
    this.missile.delete(false);
  }

  private getTrajectory(dst: TileRef): TileRef[] {
    return this.pathFinder.findPath(this.src!, dst) ?? [];
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return CruiseMissileExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      dst: this.dst,
      rocketDirectionUp: this.rocketDirectionUp,
      speed: this.speed,
      waitTicks: this.waitTicks,
      src: this.src,
      missile: w.unitOrNull(this.missile),
      pathFinder: this.pathFinder ? parabolaState(this.pathFinder) : null,
    });
  }

  restoreSnapshot(s: CruiseMissileState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.dst = s.dst;
    this.rocketDirectionUp = s.rocketDirectionUp;
    this.speed = s.speed;
    this.waitTicks = s.waitTicks;
    this.src = s.src;
    this.missile = r.unitOrNull(s.missile);
    if (s.pathFinder) {
      this.pathFinder = restoreParabola(r.game, s.pathFinder);
    }
  }
}

const CruiseMissileStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  dst: zTile(),
  rocketDirectionUp: z.boolean(),
  speed: zNum(),
  waitTicks: zInt(),
  src: zTile().nullable(),
  missile: zRef().nullable(),
  pathFinder: ParabolaSchema.nullable(),
});
type CruiseMissileState = z.infer<typeof CruiseMissileStateSchema>;

export const CruiseMissileExecutionSnapshot = execSnapshotType({
  name: "CruiseMissile",
  version: 1,
  schema: CruiseMissileStateSchema,
  cls: () => CruiseMissileExecution,
});
