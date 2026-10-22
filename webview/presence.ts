/**
 * Who else is editing: a row of avatars in the editor's top-right corner
 * while a collaboration session is on, coloured like their carets.
 */
import { hueVar, initials, type Person } from "./collab";

export class Presence {
  private readonly el = document.createElement("div");

  constructor(parent: HTMLElement = document.body) {
    this.el.className = "ken-presence";
    this.el.hidden = true;
    parent.append(this.el);
  }

  show(people: Person[]) {
    this.el.hidden = false;
    this.el.replaceChildren();
    const live = document.createElement("span");
    live.className = "ken-presence-live";
    live.textContent = "Live";
    live.title =
      people.length === 0
        ? "Shared live; no one else has this document open yet"
        : `Shared live with ${people.map((p) => p.name).join(", ")}`;
    this.el.append(live);
    // The same person in several editors shows once.
    const seen = new Set<string>();
    for (const p of people) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      const a = document.createElement("span");
      a.className = "ken-avatar";
      a.style.setProperty("--who", hueVar(p.hue));
      a.textContent = initials(p.name);
      a.title = p.name;
      this.el.append(a);
    }
  }

  hide() {
    this.el.hidden = true;
    this.el.replaceChildren();
  }
}
