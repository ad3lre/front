import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEnv } from "../../src/client/ClientEnv";

vi.mock("../../src/client/LobbySocket", () => ({
  PublicLobbySocket: class {
    start(): void {}
    stop(): void {}
  },
}));

const lastBroadcast = vi.hoisted(() => ({
  current: null as { response: UserMeResponse | false } | null,
}));

vi.mock("../../src/client/UserMeBroadcast", () => ({
  lastUserMeResponse: () => lastBroadcast.current,
}));

// Registers <game-mode-selector> as a side effect.
import "../../src/client/GameModeSelector";

type Selector = HTMLElement & { updateComplete: Promise<unknown> };

function me(trustTier: "trusted" | "untrusted"): UserMeResponse {
  return {
    user: { email: "player@example.com" },
    player: { trustTier },
  } as unknown as UserMeResponse;
}

async function mount(): Promise<Selector> {
  const selector = document.createElement("game-mode-selector") as Selector;
  document.body.appendChild(selector);
  await selector.updateComplete;
  return selector;
}

async function broadcast(
  selector: Selector,
  response: UserMeResponse | false,
): Promise<void> {
  document.dispatchEvent(
    new CustomEvent("userMeResponse", { detail: response }),
  );
  await selector.updateComplete;
}

beforeEach(() => {
  window.BOOTSTRAP_CONFIG = {
    gameEnv: "dev",
    numWorkers: 1,
    turnstileSiteKey: "",
    jwtAudience: "test",
    instanceId: "test",
    gitCommit: "test",
  };
  ClientEnv.reset();
  lastBroadcast.current = null;
});

afterEach(() => {
  document.body.innerHTML = "";
  window.BOOTSTRAP_CONFIG = undefined;
  ClientEnv.reset();
});

describe("Ranked button without account requirement", () => {
  it.each([
    ["before /users/@me", null],
    ["trusted", me("trusted")],
    ["untrusted", me("untrusted")],
    ["signed out", false],
  ] as const)("shows no trust lock for a %s viewer", async (_, response) => {
    const selector = await mount();
    if (response !== null) await broadcast(selector, response);
    expect(selector.querySelector("[data-trust]")).toBeNull();
  });
});

describe("Ranked button opens the ranked modal regardless of trust", () => {
  let showPage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    showPage = vi.fn();
    (window as unknown as { showPage: unknown }).showPage = showPage;
  });

  afterEach(() => {
    delete (window as unknown as { showPage?: unknown }).showPage;
  });

  async function clickRanked(selector: Selector): Promise<void> {
    const button = [
      ...selector.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent?.includes("mode_selector.ranked_title"));
    expect(button).toBeDefined();
    button!.click();
    await selector.updateComplete;
  }

  it.each([
    ["untrusted", me("untrusted")],
    ["trusted", me("trusted")],
    ["signed out", false],
  ] as const)("opens it for a %s viewer", async (_, response) => {
    const selector = await mount();
    await broadcast(selector, response);
    await clickRanked(selector);
    expect(showPage).toHaveBeenCalledWith("page-ranked");
    expect(selector.querySelector("confirm-dialog")).toBeNull();
  });
});
