import { MODULE_ID, DRAG_TYPE, normalizeEntries, getQuantity } from "./core.js";

const { ApplicationV2 } = foundry.applications.api;

const L = key => game.i18n.localize(`CRATEPOP.${key}`);
const F = (key, data) => game.i18n.format(`CRATEPOP.${key}`, data);

export function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

/**
 * The crate window. One per crate token. It reads the crate's contents straight from
 * the token, and every change goes through the GM (see main.js `request`).
 */
export class CratePopApp extends ApplicationV2 {
  /** Set by main.js so this file does not import it back. */
  static hooks = {
    request: async () => ({ ok: false }),
    takeTo: async () => {},
    defaultActor: () => null,
    adapter: null
  };

  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID],
    tag: "div",
    window: { icon: "fa-solid fa-box-open", resizable: true },
    position: { width: 380, height: "auto" },
    actions: {
      take: CratePopApp.#onTake,
      takeOne: CratePopApp.#onTakeOne,
      increase: CratePopApp.#onIncrease,
      decrease: CratePopApp.#onDecrease,
      remove: CratePopApp.#onRemove,
      toggleLock: CratePopApp.#onToggleLock
    }
  };

  #opened = false;
  #listening = false;

  constructor(tokenDocument, options = {}) {
    super({
      ...options,
      id: CratePopApp.idFor(tokenDocument),
      // The system's id as a class lets the system's own stylesheet reach this window,
      // the same way it reaches that system's sheets.
      classes: [game.system.id, "sheet"]
    });
    this.tokenDocument = tokenDocument;
  }

  static idFor(tokenDocument) {
    return `${MODULE_ID}-${tokenDocument.parent?.id ?? "scene"}-${tokenDocument.id}`;
  }

  get title() {
    return this.tokenDocument.name || L("DefaultName");
  }

  get entries() {
    return normalizeEntries(this.tokenDocument.getFlag(MODULE_ID, "items"));
  }

  get locked() {
    return !!this.tokenDocument.getFlag(MODULE_ID, "locked");
  }

  get reference() {
    return { sceneId: this.tokenDocument.parent?.id, tokenId: this.tokenDocument.id };
  }

  /* -------------------------------------------- */

  async _prepareContext() {
    const isGM = game.user.isGM;
    const adapter = CratePopApp.hooks.adapter;
    return {
      isGM,
      locked: this.locked,
      opening: !this.#opened,
      target: CratePopApp.hooks.defaultActor(),
      entries: this.entries.map((e, i) => ({
        id: e.id,
        index: i,
        name: e.data.name ?? "?",
        img: e.data.img || "icons/svg/item-bag.svg",
        type: e.data.type ?? "",
        qty: e.qty,
        stackable: getQuantity(e.data, adapter ?? undefined) !== null
      }))
    };
  }

  async _renderHTML(context) {
    const html = renderCrateHTML(context);
    this.#opened = true;
    return html;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  async _onRender(context, options) {
    await super._onRender?.(context, options);
    const root = this.element;

    // Drag an item out of the crate onto a character sheet.
    for (const row of root.querySelectorAll(".cp-entry[draggable='true']")) {
      row.addEventListener("dragstart", event => {
        const data = { type: DRAG_TYPE, ...this.reference, entryId: row.dataset.entryId, qty: "all" };
        event.dataTransfer.setData("text/plain", JSON.stringify(data));
        event.dataTransfer.effectAllowed = "move";
        row.classList.add("cp-dragging");
        CratePopApp.activeDrag = data;
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("cp-dragging");
        CratePopApp.activeDrag = null;
      });
    }

    // The window's frame survives re-renders, so these listeners go on once only.
    if (this.#listening) return;
    this.#listening = true;

    // The GM adds items by dropping them on the crate window.
    root.addEventListener("dragover", event => {
      if (CratePopApp.activeDrag) return;
      event.preventDefault();
      root.classList.add("cp-drop-hover");
    });
    root.addEventListener("dragleave", event => {
      if (!root.contains(event.relatedTarget)) root.classList.remove("cp-drop-hover");
    });
    root.addEventListener("drop", event => this.#onDropItem(event));
  }

  async #onDropItem(event) {
    this.element.classList.remove("cp-drop-hover");
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
    if (!data || data.type === DRAG_TYPE) return;
    event.preventDefault();
    event.stopPropagation();
    if (data.type !== "Item" || !data.uuid) return ui.notifications.warn(L("OnlyItems"));
    if (!game.user.isGM) return ui.notifications.warn(L("OnlyGMAdds"));
    const result = await CratePopApp.hooks.request("add", { ...this.reference, uuid: data.uuid });
    if (!result?.ok) CratePopApp.notifyFailure(result);
  }

  static notifyFailure(result) {
    const reason = result?.reason ?? "error";
    const key = `Errors.${reason}`;
    const text = game.i18n.has(`CRATEPOP.${key}`) ? L(key) : L("Errors.error");
    ui.notifications.warn(text);
  }

  /* -------------------------------------------- */

  static async #onTake(event, target) {
    const entryId = target.closest("[data-entry-id]")?.dataset.entryId;
    await CratePopApp.hooks.takeTo({ ...this.reference, entryId, qty: "all" }, null);
  }

  static async #onTakeOne(event, target) {
    const entryId = target.closest("[data-entry-id]")?.dataset.entryId;
    await CratePopApp.hooks.takeTo({ ...this.reference, entryId, qty: 1 }, null);
  }

  static async #onIncrease(event, target) {
    const entryId = target.closest("[data-entry-id]")?.dataset.entryId;
    const r = await CratePopApp.hooks.request("adjust", { ...this.reference, entryId, delta: 1 });
    if (!r?.ok) CratePopApp.notifyFailure(r);
  }

  static async #onDecrease(event, target) {
    const entryId = target.closest("[data-entry-id]")?.dataset.entryId;
    const r = await CratePopApp.hooks.request("adjust", { ...this.reference, entryId, delta: -1 });
    if (!r?.ok) CratePopApp.notifyFailure(r);
  }

  static async #onRemove(event, target) {
    const entryId = target.closest("[data-entry-id]")?.dataset.entryId;
    const r = await CratePopApp.hooks.request("remove", { ...this.reference, entryId });
    if (!r?.ok) CratePopApp.notifyFailure(r);
  }

  static async #onToggleLock() {
    const r = await CratePopApp.hooks.request("lock", { ...this.reference, locked: !this.locked });
    if (!r?.ok) CratePopApp.notifyFailure(r);
  }
}

CratePopApp.activeDrag = null;

/* -------------------------------------------- */

/** Pure HTML builder, kept separate so it can be tested. */
export function renderCrateHTML(context) {
  const { isGM, locked, opening, target, entries } = context;
  const rows = entries.map(e => {
    const qty = e.qty > 1 ? `<span class="cp-qty">&times;${e.qty}</span>` : "";
    const controls = isGM
      ? `<button type="button" class="cp-icon" data-action="decrease" data-tooltip="${escapeHTML(L("Decrease"))}" aria-label="${escapeHTML(L("Decrease"))}"><i class="fa-solid fa-minus"></i></button>
         <button type="button" class="cp-icon" data-action="increase" data-tooltip="${escapeHTML(L("Increase"))}" aria-label="${escapeHTML(L("Increase"))}"><i class="fa-solid fa-plus"></i></button>
         <button type="button" class="cp-icon" data-action="remove" data-tooltip="${escapeHTML(L("Remove"))}" aria-label="${escapeHTML(L("Remove"))}"><i class="fa-solid fa-trash"></i></button>`
      : `${e.qty > 1 ? `<button type="button" data-action="takeOne">${escapeHTML(L("TakeOne"))}</button>` : ""}
         <button type="button" data-action="take">${escapeHTML(e.qty > 1 ? L("TakeAll") : L("Take"))}</button>`;
    return `<li class="cp-entry" data-entry-id="${escapeHTML(e.id)}" draggable="true" style="--cp-i:${e.index}">
      <img class="cp-img" src="${escapeHTML(e.img)}" alt="" draggable="false">
      <span class="cp-name">${escapeHTML(e.name)}</span>${qty}
      <span class="cp-controls">${controls}</span>
    </li>`;
  }).join("");

  const body = entries.length
    ? `<ol class="cp-list">${rows}</ol>`
    : `<p class="cp-empty">${escapeHTML(isGM ? L("EmptyGM") : L("Empty"))}</p>`;

  const footer = isGM
    ? `<footer class="cp-footer">
        <span class="cp-hint">${escapeHTML(L("DropHint"))}</span>
        <button type="button" data-action="toggleLock" class="cp-lock ${locked ? "active" : ""}">
          <i class="fa-solid ${locked ? "fa-lock" : "fa-lock-open"}"></i> ${escapeHTML(locked ? L("Locked") : L("Unlocked"))}
        </button>
      </footer>`
    : `<footer class="cp-footer"><span class="cp-hint">${escapeHTML(target ? F("TakingTo", { name: target.name }) : L("NoTarget"))}</span></footer>`;

  return `<div class="cp-crate ${opening ? "cp-opening" : "cp-open"}">
    <div class="cp-lid" aria-hidden="true"><span class="cp-flap cp-flap-left"></span><span class="cp-flap cp-flap-right"></span></div>
    <div class="cp-interior">${body}</div>
    ${footer}
  </div>`;
}
