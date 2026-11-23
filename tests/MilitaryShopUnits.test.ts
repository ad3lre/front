import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { ArtilleryExecution } from "@openfront/engine/execution/ArtilleryExecution";
import { BomberExecution } from "@openfront/engine/execution/BomberExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { CruiseMissileExecution } from "@openfront/engine/execution/CruiseMissileExecution";
import { MissileSiloExecution } from "@openfront/engine/execution/MissileSiloExecution";
import { WarshipExecution } from "@openfront/engine/execution/WarshipExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

describe("Military shop units", () => {
  let game: Game;
  let attacker: Player;
  let defender: Player;

  beforeEach(async () => {
    game = await setup(
      "plains",
      { infiniteGold: true, instantBuild: true },
      [
        new PlayerInfo("attacker", PlayerType.Human, null, "atk"),
        new PlayerInfo("defender", PlayerType.Human, null, "def"),
      ],
    );
    attacker = game.player("atk");
    defender = game.player("def");

    // Claim some land so structures can be placed.
    for (let x = 0; x < 20; x++) {
      for (let y = 0; y < 20; y++) {
        const tile = game.ref(x, y);
        if (game.isLand(tile) && !game.hasOwner(tile)) {
          attacker.conquer(tile);
        }
      }
    }
    for (let x = 40; x < 60; x++) {
      for (let y = 40; y < 60; y++) {
        const tile = game.ref(x, y);
        if (game.isLand(tile) && !game.hasOwner(tile)) {
          defender.conquer(tile);
        }
      }
    }
  });

  test("Cruise missile disables then destroys a defense post", () => {
    const siloTile = game.ref(5, 5);
    const silo = attacker.buildUnit(UnitType.MissileSilo, siloTile, {});
    game.addExecution(new MissileSiloExecution(silo));
    const post = defender.buildUnit(
      UnitType.DefensePost,
      game.ref(50, 50),
      {},
    );

    game.addExecution(
      new CruiseMissileExecution(attacker, post.tile(), true),
    );
    // Poll until the first cruise has landed (missile unit gone).
    for (
      let i = 0;
      i < 800 && attacker.units(UnitType.CruiseMissile).length > 0;
      i++
    ) {
      game.executeNextTick();
    }
    for (
      let i = 0;
      i < 50 && post.isActive() && !post.isCruiseDisabled();
      i++
    ) {
      game.executeNextTick();
    }

    expect(post.isActive()).toBe(true);
    expect(post.isCruiseDisabled()).toBe(true);

    // Wait out silo cooldown (with MissileSiloExecution reloading).
    executeTicks(game, game.config().SiloCooldown() + 5);
    expect(silo.isInCooldown()).toBe(false);

    game.addExecution(
      new CruiseMissileExecution(attacker, post.tile(), true),
    );
    for (let i = 0; i < 800 && post.isActive(); i++) {
      game.executeNextTick();
    }

    expect(post.isActive()).toBe(false);
  });

  test("Artillery shells an enemy defense post in range", () => {
    const artyTile = game.ref(10, 10);
    const postTile = game.ref(45, 45);
    // Bring them closer so they're within artillery range (50).
    const nearPost = defender.buildUnit(
      UnitType.DefensePost,
      game.ref(20, 20),
      {},
    );
    const arty = attacker.buildUnit(UnitType.Artillery, artyTile, {});
    game.addExecution(new ArtilleryExecution(arty));

    executeTicks(game, 200);

    // Post should have taken shell damage or been deleted (no health by default).
    // Defense posts typically have no maxHealth, so a shell deletes them.
    expect(nearPost.isActive()).toBe(false);
    expect(postTile).toBeDefined();
  });

  test("Mine boosts goldAdditionRate", () => {
    const without = game.config().goldAdditionRate(attacker);
    attacker.buildUnit(UnitType.Mine, game.ref(6, 6), {});
    const withMine = game.config().goldAdditionRate(attacker);
    expect(withMine - without).toBe(
      BigInt(game.config().mineGoldPerTick()),
    );
  });

  test("Bomber destroys an enemy city near the target", () => {
    const cityTile = game.ref(8, 8);
    attacker.buildUnit(UnitType.City, cityTile, {});
    const enemyCity = defender.buildUnit(UnitType.City, game.ref(50, 50), {});

    game.addExecution(new BomberExecution(attacker, enemyCity.tile()));
    executeTicks(game, 500);

    expect(enemyCity.isActive()).toBe(false);
  });

  test("Submarine spawns from a port via construction", async () => {
    const oceanGame = await setup(
      "half_land_half_ocean",
      { infiniteGold: true, instantBuild: true },
      [new PlayerInfo("navy", PlayerType.Human, null, "navy")],
    );
    const navy = oceanGame.player("navy");
    const coastX = 7;
    const height = oceanGame.height();
    for (let y = 0; y < height; y++) {
      const tile = oceanGame.ref(coastX, y);
      if (oceanGame.isLand(tile) && !oceanGame.hasOwner(tile)) {
        navy.conquer(tile);
      }
    }
    const portY = Math.min(10, height - 1);
    navy.buildUnit(UnitType.Port, oceanGame.ref(coastX, portY), {});
    const patrol = oceanGame.ref(coastX + 2, portY);
    expect(oceanGame.isWater(patrol)).toBe(true);
    oceanGame.addExecution(
      new ConstructionExecution(navy, UnitType.Submarine, patrol),
    );
    executeTicks(oceanGame, 5);

    expect(navy.units(UnitType.Submarine).length).toBe(1);
    const sub = navy.units(UnitType.Submarine)[0];
    oceanGame.addExecution(new WarshipExecution(sub));
    executeTicks(oceanGame, 10);
    expect(sub.isActive()).toBe(true);
  });
});
