import { LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

const STEAM_APP_ID = "3560670";

/** Store page URL helper kept for any remaining callers. */
export function steamStoreUrl(campaign: string): string {
  const params = new URLSearchParams({
    utm_source: "openfront",
    utm_medium: "link",
    utm_campaign: campaign,
  });
  return `https://store.steampowered.com/app/${STEAM_APP_ID}/OpenFront/?${params}`;
}

/**
 * Steam store widget — disabled on RXND standalone (no "Buy OpenFront" promos).
 */
@customElement("steam-wishlist")
export class SteamWishlist extends LitElement {
  @property({ type: String }) campaign = "";
  @property({ type: Boolean }) active = true;

  createRenderRoot() {
    return this;
  }

  render() {
    return nothing;
  }
}
