import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUserMe = vi.fn<() => Promise<UserMeResponse | false>>();

vi.mock("../../src/client/Api", () => ({
  getUserMe: () => getUserMe(),
}));

vi.mock("../../src/client/TerrainMapFileLoader", () => ({
  terrainMapFileLoader: { getMapData: vi.fn() },
}));

vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
  getMapName: vi.fn(),
  getModifierLabels: vi.fn(() => []),
}));

import { RankedModal } from "../../src/client/components/RankedModal";

function userMe(trustTier?: "trusted" | "untrusted" | null): UserMeResponse {
  return {
    user: { email: "player@example.com" },
    player: {
      publicId: "player-id",
      adfree: false,
      unlimitedRanked: false,
      canCreatePublicLobbies: false,
      achievements: { singleplayerMap: [], player: [] },
      friends: [],
      subscription: null,
      trustTier,
    },
  } as unknown as UserMeResponse;
}

describe("RankedModal without account requirement", () => {
  let modal: RankedModal;

  beforeEach(() => {
    getUserMe.mockReset();
    modal = new RankedModal();
    document.body.appendChild(modal);
  });

  afterEach(() => {
    modal.remove();
  });

  async function openWith(response: UserMeResponse | false): Promise<void> {
    getUserMe.mockReturnValue(Promise.resolve(response));
    modal.open();
    await vi.waitFor(() => expect(getUserMe).toHaveBeenCalled());
    await vi.waitFor(async () => {
      await modal.updateComplete;
      expect((modal as unknown as { loading: boolean }).loading).toBe(false);
    });
    await modal.updateComplete;
  }

  it("shows no trust locks on ranked cards", async () => {
    await openWith(userMe("trusted"));
    expect(modal.querySelectorAll("[data-trust]")).toHaveLength(0);
  });

  it("has no FFA card", async () => {
    await openWith(userMe("trusted"));
    expect(modal.textContent).not.toContain("mode_selector.ranked_ffa_title");
  });

  describe("clicking a ranked mode", () => {
    let openMatchmaking: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      openMatchmaking = vi.fn();
      document.addEventListener(
        "open-matchmaking",
        openMatchmaking as EventListener,
      );
    });

    afterEach(() => {
      document.removeEventListener(
        "open-matchmaking",
        openMatchmaking as EventListener,
      );
    });

    async function click(index: number): Promise<void> {
      const buttons = [
        ...modal.querySelectorAll<HTMLButtonElement>("button"),
      ].filter((b) =>
        /mode_selector\.ranked_(1v1|2v2)_title/.test(b.textContent ?? ""),
      );
      buttons[index]!.click();
      await modal.updateComplete;
    }

    it.each([
      ["trusted", userMe("trusted")],
      ["untrusted", userMe("untrusted")],
      ["guest", userMe(null)],
      ["signed out", false],
    ] as const)("opens matchmaking for a %s viewer", async (_, response) => {
      await openWith(response);
      await click(0);
      await vi.waitFor(() =>
        expect(openMatchmaking).toHaveBeenCalledWith(
          expect.objectContaining({ detail: { mode: "1v1" } }),
        ),
      );
      expect(modal.querySelector("confirm-dialog")).toBeNull();
    });

    it("opens 2v2 matchmaking from the second card", async () => {
      await openWith(userMe("trusted"));
      await click(1);
      await vi.waitFor(() =>
        expect(openMatchmaking).toHaveBeenCalledWith(
          expect.objectContaining({ detail: { mode: "2v2" } }),
        ),
      );
    });
  });
});
