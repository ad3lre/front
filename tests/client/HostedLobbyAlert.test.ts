// @vitest-environment jsdom
import { PublicGameInfo, PublicGames } from "@openfront/shared/WireSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/Utils")>();
  return {
    ...actual,
    translateText: (key: string) => key,
    getGameModeLabel: () => "FFA",
  };
});

import { HostedLobbyAlert } from "../../src/client/components/HostedLobbyAlert";

function lobby(id: string): PublicGameInfo {
  return {
    gameID: id,
    numClients: 2,
    publicGameType: "hosted",
    custom: true,
  };
}

function publish(hosted: PublicGameInfo[]) {
  const payload: PublicGames = {
    serverTime: Date.now(),
    games: { hosted },
  };
  document.dispatchEvent(
    new CustomEvent("public-lobbies-update", { detail: { payload } }),
  );
}

describe("HostedLobbyAlert", () => {
  let el: HostedLobbyAlert;

  beforeEach(async () => {
    document.body.classList.remove("in-game");
    if (!customElements.get("hosted-lobby-alert")) {
      customElements.define("hosted-lobby-alert", HostedLobbyAlert);
    }
    el = document.createElement("hosted-lobby-alert") as HostedLobbyAlert;
    document.body.appendChild(el);
    await el.updateComplete;
  });

  afterEach(() => {
    el.remove();
    document.body.classList.remove("in-game");
  });

  it("does not alert on the first lobby snapshot", async () => {
    publish([lobby("a")]);
    await el.updateComplete;
    expect(el.querySelector("[role='status']")).toBeNull();
  });

  it("alerts when a new hosted lobby appears", async () => {
    publish([lobby("a")]);
    publish([lobby("a"), lobby("b")]);
    await el.updateComplete;
    const status = el.querySelector("[role='status']");
    expect(status).not.toBeNull();
    expect(
      `${status?.textContent ?? ""} ${status?.innerHTML ?? ""}`,
    ).toContain("public_lobby.lobby_created_join");
  });

  it("stays quiet while in a game", async () => {
    publish([lobby("a")]);
    document.body.classList.add("in-game");
    publish([lobby("a"), lobby("b")]);
    await el.updateComplete;
    expect(el.querySelector("[role='status']")).toBeNull();
  });

  it("dispatches join-lobby from the Join button", async () => {
    publish([lobby("a")]);
    publish([lobby("a"), lobby("b")]);
    await el.updateComplete;

    const joins: CustomEvent[] = [];
    const onJoin = (e: Event) => joins.push(e as CustomEvent);
    document.addEventListener("join-lobby", onJoin);
    const joinBtn = [...el.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("public_lobby.lobby_created_join"),
    );
    expect(joinBtn).toBeTruthy();
    joinBtn!.click();
    document.removeEventListener("join-lobby", onJoin);

    expect(joins).toHaveLength(1);
    expect(joins[0]!.detail.gameID).toBe("b");
    expect(joins[0]!.detail.source).toBe("public");
  });
});
