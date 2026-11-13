import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export function createStatistics(dir, publicIdFor) {
  const db = new DatabaseSync(join(dir, "games.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS results(game_id TEXT NOT NULL, public_id TEXT NOT NULL, username TEXT NOT NULL,
      outcome TEXT NOT NULL, game_type TEXT NOT NULL, game_mode TEXT NOT NULL, difficulty TEXT NOT NULL,
      ranked_type TEXT, ended INTEGER NOT NULL, PRIMARY KEY(game_id, public_id));
    CREATE INDEX IF NOT EXISTS results_player ON results(public_id, ended DESC);`);
  const addGame = db.prepare("INSERT INTO games(id, record) VALUES (?, ?)");
  const addResult = db.prepare("INSERT INTO results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const getGame = db.prepare("SELECT record FROM games WHERE id = ?");
  const playerRows = db.prepare("SELECT * FROM results WHERE public_id = ? ORDER BY ended DESC");
  function archive(id, record) {
    const info = record.info, winner = info.winner, results = [], seen = new Set();
    if (Array.isArray(winner) && winner.length > 1) for (const player of info.players) {
      const uuid = player.persistentID;
      if (typeof uuid !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid)) continue;
      const publicId = publicIdFor(Buffer.from(uuid.replaceAll("-", ""), "hex").toString("base64url"));
      if (seen.has(publicId)) continue;
      seen.add(publicId);
      const won = winner[0] === "player" ? winner.slice(1).includes(player.clientID)
        : winner[0] === "team" && (winner.slice(2).includes(player.clientID) || player.team === winner[1]);
      results.push([id, publicId, String(player.username ?? "Player").slice(0, 80), won ? "win" : "loss",
        ["Public", "Private", "Singleplayer"].includes(info.config?.gameType) ? info.config.gameType : "Private",
        ["Free For All", "Team"].includes(info.config?.gameMode) ? info.config.gameMode : "Free For All",
        ["Easy", "Medium", "Hard", "Impossible"].includes(info.config?.difficulty) ? info.config.difficulty : "Medium",
        info.statsAgreed === true && ["1v1", "2v2"].includes(info.config?.rankedType) ? info.config.rankedType : null,
        Number.isSafeInteger(info.end) ? info.end : Date.now()]);
    }
    for (const player of info.players) player.persistentID = null;
    delete info.reports;
    try {
      db.exec("BEGIN IMMEDIATE");
      addGame.run(id, JSON.stringify(record));
      for (const row of results) addResult.run(...row);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      db.exec("ROLLBACK");
      if (String(error.message).includes("UNIQUE constraint failed: games.id")) return false;
      throw error;
    }
  }
  function profile(publicId) {
    const rows = playerRows.all(publicId);
    if (!rows.length) return null;
    const stats = {};
    for (const row of rows) {
      const mode = ((stats[row.game_type] ??= {})[row.game_mode] ??= {});
      const target = (mode[row.difficulty] ??= { wins: "0", losses: "0", total: "0", stats: {} });
      const field = row.outcome === "win" ? "wins" : "losses";
      target[field] = String(Number(target[field]) + 1); target.total = String(Number(target.total) + 1);
      if (row.ranked_type) {
        const rank = ((stats.Ranked ??= {})[row.ranked_type] ??= { wins: "0", losses: "0", total: "0", stats: {} });
        rank[field] = String(Number(rank[field]) + 1); rank.total = String(Number(rank.total) + 1);
      }
    }
    return { createdAt: new Date(Math.min(...rows.map(r => r.ended))).toISOString(), username: rows[0].username, stats };
  }
  function leaderboard() {
    const rows = db.prepare(`SELECT public_id, ranked_type, MAX(ended) AS last_game,
      SUM(outcome = 'win') AS wins, SUM(outcome = 'loss') AS losses,
      (SELECT username FROM results x WHERE x.public_id=r.public_id ORDER BY ended DESC LIMIT 1) AS username
      FROM results r WHERE ranked_type IS NOT NULL GROUP BY public_id, ranked_type ORDER BY wins DESC, losses ASC, last_game ASC`).all();
    const result = { "1v1": [], "2v2": [], "FFA": [] };
    for (const row of rows) {
      const list = result[row.ranked_type]; if (!list) continue;
      list.push({ rank: list.length + 1, elo: 1000 + row.wins * 20 - row.losses * 20, peakElo: null,
        wins: row.wins, losses: row.losses, total: row.wins + row.losses, public_id: row.public_id, accountUsername: row.username });
    }
    return result;
  }
  return { archive, replay: id => getGame.get(id)?.record, profile, leaderboard };
}
