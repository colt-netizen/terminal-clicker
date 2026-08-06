/*
 * Runs in the PAGE's world at document_start, before MLB's app boots.
 *
 * MLB's player creates CLOSED shadow roots, which no DOM API can traverse —
 * that is why every scan (break banners, the game rail, team logos) kept
 * finding nothing that was visibly on screen. Forcing every shadow root open
 * before the app creates them makes the page inspectable again; the isolated-
 * world content script can then walk the roots via el.shadowRoot as normal.
 *
 * This must be a separate MAIN-world script: content scripts live in an
 * isolated world, and patching a prototype there would not affect the page.
 */
(() => {
  const original = Element.prototype.attachShadow;
  if (!original) return;
  Element.prototype.attachShadow = function attachShadow(init) {
    return original.call(this, { ...(init || {}), mode: 'open' });
  };
})();
