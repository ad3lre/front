import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import {
  PublicGameInfo,
  PublicGames,
} from "@openfront/shared/WireSchemas";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { lastUserMeResponse } from "../UserMeBroadcast";
import { getGameModeLabel, translateText } from "../Utils";
import { canJoinTrustedLobby, viewerIsTrusted } from "./LobbyCard";

const ALERT_MS = 20_000;

/**
 * Homepage toast when a new hosted (custom) lobby appears on the public feed.
 * Hidden while in a match or already waiting in a lobby; Join dispatches the
 * same join-lobby event lobby cards use.
 */
@customElement("hosted-lobby-alert")
export class HostedLobbyAlert extends LitElement {
  @state() private lobby: PublicGameInfo | null = null;
  @state() private viewerTrusted = false;

  private seenIds = new Set<string>();
  private seeded = false;
  private inLobby = false;
  private hideTimer: number | undefined;
  private bodyObserver: MutationObserver | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    const lastMe = lastUserMeResponse();
    if (lastMe) this.viewerTrusted = viewerIsTrusted(lastMe.response);
    document.addEventListener(
      "public-lobbies-update",
      this.onLobbiesUpdate as EventListener,
    );
    document.addEventListener("join-lobby", this.onJoinLobby);
    document.addEventListener("leave-lobby", this.onLeaveLobby);
    document.addEventListener("userMeResponse", this.onUserMe);
    this.bodyObserver = new MutationObserver(() => {
      if (document.body.classList.contains("in-game")) this.clearAlert();
    });
    this.bodyObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener(
      "public-lobbies-update",
      this.onLobbiesUpdate as EventListener,
    );
    document.removeEventListener("join-lobby", this.onJoinLobby);
    document.removeEventListener("leave-lobby", this.onLeaveLobby);
    document.removeEventListener("userMeResponse", this.onUserMe);
    this.bodyObserver?.disconnect();
    this.bodyObserver = null;
    window.clearTimeout(this.hideTimer);
  }

  private readonly onUserMe = (event: Event) => {
    const detail = (event as CustomEvent<UserMeResponse | false>).detail;
    this.viewerTrusted = viewerIsTrusted(detail);
  };

  private readonly onJoinLobby = () => {
    this.inLobby = true;
    this.clearAlert();
  };

  private readonly onLeaveLobby = () => {
    this.inLobby = false;
  };

  private readonly onLobbiesUpdate = (event: Event) => {
    const detail = (event as CustomEvent<{ payload: PublicGames }>).detail;
    const hosted = detail?.payload?.games?.hosted ?? [];
    const ids = new Set(hosted.map((g) => g.gameID));

    if (!this.seeded) {
      this.seenIds = ids;
      this.seeded = true;
      return;
    }

    const newcomers = hosted.filter((g) => !this.seenIds.has(g.gameID));
    this.seenIds = ids;

    if (
      newcomers.length === 0 ||
      this.inLobby ||
      document.body.classList.contains("in-game")
    ) {
      if (this.lobby && !ids.has(this.lobby.gameID)) this.clearAlert();
      return;
    }

    this.showLobby(newcomers[newcomers.length - 1]!);
  };

  private showLobby(lobby: PublicGameInfo) {
    this.lobby = lobby;
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.clearAlert(), ALERT_MS);
  }

  private clearAlert() {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    this.lobby = null;
  }

  private dismiss = () => {
    this.clearAlert();
  };

  private join = () => {
    const lobby = this.lobby;
    if (!lobby) return;

    const usernameInput = document.querySelector("username-input") as {
      canPlay(): boolean;
    } | null;
    if (usernameInput && !usernameInput.canPlay()) return;

    if (!canJoinTrustedLobby(lobby, this.viewerTrusted)) {
      this.clearAlert();
      return;
    }

    this.clearAlert();
    document.dispatchEvent(
      new CustomEvent("join-lobby", {
        detail: {
          gameID: lobby.gameID,
          source: "public",
          publicLobbyInfo: lobby,
        },
        bubbles: true,
        composed: true,
      }),
    );
  };

  render() {
    if (!this.lobby || document.body.classList.contains("in-game")) {
      return nothing;
    }

    const mode = this.lobby.gameConfig
      ? getGameModeLabel(this.lobby.gameConfig)
      : translateText("public_lobby.custom");
    const players = String(this.lobby.numClients);

    return html`
      <div
        class="fixed top-20 z-[10000] left-4 right-4 w-auto sm:left-auto sm:right-4 sm:w-[280px] bg-[#10202a] border border-[#2da8f5]/35 rounded-xl shadow-lg p-3"
        role="status"
        aria-live="polite"
        aria-label=${translateText("public_lobby.lobby_created_title")}
      >
        <div class="flex items-start gap-2 mb-2">
          <div class="flex-1 min-w-0">
            <div class="text-xs font-bold text-white">
              ${
                this.lobby.label?.trim()
                  ? this.lobby.label
                  : translateText("public_lobby.lobby_created_title")
              }
            </div>
            <div class="text-[11px] leading-snug text-white/60 mt-0.5">
              ${translateText("public_lobby.lobby_created_body", {
                players,
                mode,
              })}
            </div>
          </div>
          <button
            type="button"
            class="shrink-0 grid place-items-center w-5 h-5 -mt-0.5 -mr-0.5 rounded-md text-white/40 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
            aria-label=${translateText("public_lobby.lobby_created_dismiss")}
            @click=${this.dismiss}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            class="flex-1 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-lg border border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition-all cursor-pointer"
            @click=${this.dismiss}
          >
            ${translateText("public_lobby.lobby_created_dismiss")}
          </button>
          <button
            type="button"
            class="flex-1 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-lg border border-transparent bg-[#2da8f5] text-white hover:brightness-110 transition-all cursor-pointer whitespace-nowrap"
            @click=${this.join}
          >
            ${translateText("public_lobby.lobby_created_join")}
          </button>
        </div>
      </div>
    `;
  }
}
