import { LitElement, nothing } from "lit";
import { customElement } from "lit/decorators.js";

@customElement("page-footer")
export class Footer extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    // Footer removed from the RXND shell; keep the custom element registered
    // so stray markup stays inert. Source/credit live in the account menu.
    return nothing;
  }
}
