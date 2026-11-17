import { LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

/**
 * Steam store CTA strip — disabled on RXND standalone (no "Buy OpenFront" promos).
 */
@customElement("steam-wishlist-button")
export class SteamWishlistButton extends LitElement {
  @property({ type: String }) campaign = "";

  createRenderRoot() {
    return this;
  }

  render() {
    return nothing;
  }
}
