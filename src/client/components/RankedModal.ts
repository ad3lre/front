import { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getUserMe } from "../Api";
import type { MatchmakingMode } from "../Matchmaking";
import { translateText } from "../Utils";
import { BaseModal } from "./BaseModal";
import { modalHeader } from "./ui/ModalHeader";

@customElement("ranked-modal")
export class RankedModal extends BaseModal {
  protected routerName = "ranked";

  @state() private elo: number | string = "...";
  @state() private elo2v2: number | string = "...";
  @state() private userMeResponse: UserMeResponse | false = false;
  @state() private errorMessage: string | null = null;
  @state() private loading = true;

  // Guest sessions and linked accounts both resolve to a UserMeResponse;
  // only a missing session falls through to the generic title subtitle.
  private hasProfile(): boolean {
    return this.userMeResponse !== false;
  }

  constructor() {
    super();
    this.id = "page-ranked";
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener(
      "userMeResponse",
      this.handleUserMeResponse as EventListener,
    );
  }

  disconnectedCallback() {
    document.removeEventListener(
      "userMeResponse",
      this.handleUserMeResponse as EventListener,
    );
    super.disconnectedCallback();
  }

  private handleUserMeResponse = (
    event: CustomEvent<UserMeResponse | false>,
  ) => {
    this.errorMessage = null;
    this.userMeResponse = event.detail;
    this.updateElo();
  };

  private updateElo() {
    if (this.errorMessage) {
      this.elo = translateText("map_component.error");
      this.elo2v2 = translateText("map_component.error");
      return;
    }

    if (this.hasProfile()) {
      const leaderboard = this.userMeResponse
        ? this.userMeResponse.player.leaderboard
        : undefined;
      const noElo = translateText("matchmaking_modal.no_elo");
      this.elo = leaderboard?.oneVone?.elo ?? noElo;
      this.elo2v2 = leaderboard?.twoVtwo?.elo ?? noElo;
    }
  }

  protected override async onOpen(): Promise<void> {
    this.loading = true;
    this.elo = "...";
    this.elo2v2 = "...";
    this.errorMessage = null;

    try {
      this.userMeResponse = await getUserMe();
    } catch (error) {
      console.warn("Failed to fetch user profile for ranked modal", error);
      this.userMeResponse = false;
      this.errorMessage = translateText("map_component.error");
      this.elo = translateText("map_component.error");
      this.elo2v2 = translateText("map_component.error");
    } finally {
      this.loading = false;
      this.updateElo();
    }
  }

  createRenderRoot() {
    return this;
  }

  protected renderHeaderSlot() {
    return modalHeader({
      title: translateText("mode_selector.ranked_title"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
    });
  }

  protected renderBody() {
    return html`
      <div class="custom-scrollbar p-6">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          ${this.renderCard(
            translateText("mode_selector.ranked_1v1_title"),
            this.errorMessage ??
              (this.hasProfile()
                ? translateText("matchmaking_modal.elo", { elo: this.elo })
                : translateText("mode_selector.ranked_title")),
            () => this.handleRanked("1v1"),
          )}
          ${this.renderCard(
            translateText("mode_selector.ranked_2v2_title"),
            this.errorMessage ??
              (this.hasProfile()
                ? translateText("matchmaking_modal.elo", { elo: this.elo2v2 })
                : translateText("mode_selector.ranked_title")),
            () => this.handleRanked("2v2"),
          )}
        </div>
        <p class="mt-6 text-xs text-white/60 leading-relaxed text-center">
          Players are matched in queue order. Two-on-two teams are assigned when
          the match starts.
        </p>
      </div>
    `;
  }

  private renderCard(title: string, subtitle: string, onClick: () => void) {
    return html`
      <button
        @click=${onClick}
        class="relative flex flex-col w-full h-28 sm:h-32 rounded-2xl bg-malibu-blue border-0 transition-all duration-200 hover:bg-aquarius hover:scale-[1.03] hover:shadow-[var(--shadow-action-card-hover)] active:bg-malibu-blue/80 active:scale-[0.98] p-6 items-center justify-center gap-3"
      >
        <div class="flex flex-col items-center gap-1 text-center">
          <h3
            class="text-lg sm:text-xl font-bold text-white uppercase tracking-widest leading-tight"
          >
            ${title}
          </h3>
          <p
            class="text-xs text-white/80 uppercase tracking-wider whitespace-pre-line leading-tight"
          >
            ${subtitle}
          </p>
        </div>
      </button>
    `;
  }

  private handleRanked(mode: MatchmakingMode) {
    // No account gate: guest JWTs from /auth/refresh are enough to queue.
    // Matchmaking's connect() refreshes the play token itself.
    document.dispatchEvent(
      new CustomEvent("open-matchmaking", { detail: { mode } }),
    );
  }
}
