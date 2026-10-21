/** Click-to-zoom overlay for images and Mermaid diagrams. */
export type LightboxContent = { kind: "img"; src: string; alt: string } | { kind: "svg"; svg: string };

let overlay: HTMLElement | null = null;

export function closeLightbox(): void {
  overlay?.remove();
  overlay = null;
}

export function showLightbox(content: LightboxContent): void {
  closeLightbox();
  const el = document.createElement("div");
  el.className = "ken-lightbox";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  if (content.kind === "img") {
    const img = document.createElement("img");
    img.src = content.src;
    img.alt = content.alt;
    el.append(img);
  } else {
    const box = document.createElement("div");
    box.className = "ken-lightbox-svg";
    // Already sanitised: Mermaid renders with securityLevel "strict".
    box.innerHTML = content.svg;
    el.append(box);
  }
  el.addEventListener("click", closeLightbox);
  document.body.append(el);
  overlay = el;
}
