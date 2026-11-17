import {
  GameMapSize,
  GameMode,
  PlayerType,
  RankedType,
} from "@openfront/engine-api/game/GameTypes";
import { createGameRunner } from "@openfront/engine/GameRunner";
import { describe, expect, it } from "vitest";
import { scriptedGameStart, TestDataMapLoader } from "../util/ScriptedGame";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";

describe("matchmaking bot seats in GameRunner", () => {
  it("treats isBot players as Nation-driven even when nations are disabled", async () => {
    const start = scriptedGameStart({
      gameMapSize: GameMapSize.Normal,
      rankedType: RankedType.OneVOne,
      nations: "disabled",
      bots: 0,
    });
    start.players = [
      {
        clientID: "HUMAN001",
        username: "HumanOne",
        clanTag: null,
      },
      {
        clientID: "BOT00001",
        username: "BotAmethyst",
        clanTag: null,
        isBot: true,
      },
    ];

    const mapFiles = await loadMapFiles(
      new TestDataMapLoader("plains"),
      start.config.gameMap,
      GameMapSize.Normal,
    );
    const runner = await createGameRunner(start, "HUMAN001", mapFiles, () => {});

    // Unspawned players are not isAlive(); allPlayers includes them.
    const human = runner.game
      .allPlayers()
      .find((p) => p.clientID() === "HUMAN001");
    const bot = runner.game
      .allPlayers()
      .find((p) => p.clientID() === "BOT00001");

    expect(human).toBeDefined();
    expect(human!.type()).toBe(PlayerType.Human);
    expect(bot).toBeDefined();
    expect(bot!.type()).toBe(PlayerType.Nation);

    const nationExecs = runner.game
      .executions()
      .filter((e) => e.constructor.name === "NationExecution");
    expect(nationExecs.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps teamIndex on bot nations for 2v2 pins", async () => {
    const start = scriptedGameStart({
      gameMapSize: GameMapSize.Normal,
      rankedType: RankedType.TwoVTwo,
      nations: "disabled",
      bots: 0,
      gameMode: GameMode.Team,
      playerTeams: 2,
    });
    start.players = [
      {
        clientID: "HUMAN001",
        username: "HumanOne",
        clanTag: null,
        teamIndex: 0,
      },
      {
        clientID: "BOT00001",
        username: "BotAnchor",
        clanTag: null,
        isBot: true,
        teamIndex: 1,
      },
    ];

    const mapFiles = await loadMapFiles(
      new TestDataMapLoader("plains"),
      start.config.gameMap,
      GameMapSize.Normal,
    );
    const runner = await createGameRunner(start, "HUMAN001", mapFiles, () => {});
    const bot = runner.game
      .allPlayers()
      .find((p) => p.clientID() === "BOT00001");
    expect(bot).toBeDefined();
    expect(bot!.info().teamIndex).toBe(1);
  });
});
