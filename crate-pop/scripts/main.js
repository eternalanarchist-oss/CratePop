import {
  MODULE_ID, DRAG_TYPE, getAdapter, getQuantity, createLootService
} from "./core.js";
import { CratePopApp } from "./crate-app.js";

const QUERY = `${MODULE_ID}.request`;
const L = key => game.i18n.localize(`CRATEPOP.${key}`);
const F = (key, data) => game.i18n.format(`CRATEPOP.${key}`, data);

let service = null;

/* -------------------------------------------- */
/*  Crate tokens                                */
/* -------------------------------------------- */

export function isLootToken(tokenDocument) {
  try {
    return !!tokenDocument?.getFlag?.(MODULE_ID, "container");
  } catch {
    return false;
  }
}

export function openLoot(tokenDocument) {
  if (!isLootToken(tokenDocument)) return null;
  if (!game.user.isGM) {
    if (tokenDocument.hidden) return null;
    if (tokenDocument.getFlag(MODULE_ID, "locked")) {
      ui.notifications.info(L("Errors.locked"));
      return null;
    }
  }
  const existing = foundry.applications.instances.get(CratePopApp.idFor(tokenDocument));
  if (existing) {
    existing.bringToFront?.();
    return existing;
  }
  const app = new CratePopApp(tokenDocument);
  app.render({ force: true });
  return app;
}

function openWindowsFor(tokenDocument) {
  const app = foundry.applications.instances.get(CratePopApp.idFor(tokenDocument));
  return app ? [app] : [];
}

/** GM: create a crate token in the middle of the current view. It needs no actor. */
export async function placeCrate() {
  if (!game.user.isGM || !canvas?.scene) return null;
  const size = canvas.grid.size;
  let point = { x: canvas.stage.pivot.x - size / 2, y: canvas.stage.pivot.y - size / 2 };
  try {
    point = canvas.grid.getSnappedPoint(point, { mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_CORNER });
  } catch { /* keep the unsnapped point */ }
  const extra = {};
  // Foundry 14 scenes can have several levels: put the crate on the one being viewed.
  if (canvas.level?.id) extra.level = canvas.level.id;
  const [token] = await canvas.scene.createEmbeddedDocuments("Token", [{
    ...extra,
    name: L("DefaultName"),
    x: Math.round(point.x),
    y: Math.round(point.y),
    width: 1,
    height: 1,
    actorId: null,
    actorLink: false,
    lockRotation: true,
    texture: { src: `modules/${MODULE_ID}/assets/crate.svg` },
    displayName: CONST.TOKEN_DISPLAY_MODES.HOVER,
    disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
    flags: { [MODULE_ID]: { container: true, items: [], locked: false } }
  }]);
  return token;
}

/** GM: turn any token into a crate, or back. */
export async function toggleCrate(tokenDocument) {
  if (!game.user.isGM || !tokenDocument) return;
  if (isLootToken(tokenDocument)) {
    await tokenDocument.update({ [`flags.${MODULE_ID}.container`]: false });
  } else {
    const items = tokenDocument.getFlag(MODULE_ID, "items") ?? [];
    await tokenDocument.update({ [`flags.${MODULE_ID}`]: { container: true, items, locked: false } });
  }
}

/* -------------------------------------------- */
/*  Talking to the GM                           */
/* -------------------------------------------- */

/**
 * Every change to a crate is done by one browser only: the active GM's. Players send it a
 * request with Foundry's query system (v13 and later) and wait for the answer.
 */
export async function request(action, payload) {
  const gm = game.users.activeGM;
  if (!gm) return { ok: false, reason: "noGM" };
  const data = { action, payload, userId: game.user.id };
  if (gm.isSelf) return service.handle(data);
  try {
    return await gm.query(QUERY, data, { timeout: 15000 });
  } catch (err) {
    console.warn(`${MODULE_ID} | Request to the GM failed`, err);
    return { ok: false, reason: "timeout" };
  }
}

/** Runs on the GM's browser when a player's request arrives. */
export function handleQuery(data) {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return { ok: false, reason: "notActiveGM" };
  return service.handle(data);
}

/** The character a player's "Take" button gives items to. */
export function defaultActor() {
  const owned = a => a && a.isOwner;
  const assigned = game.user.character;
  if (!game.user.isGM && owned(assigned)) return assigned;
  const controlled = canvas?.tokens?.controlled?.map(t => t.actor).find(owned);
  if (controlled) return controlled;
  if (game.user.isGM) return null;
  return game.actors?.find(a => owned(a) && a.hasPlayerOwner) ?? null;
}

export async function takeTo(reference, actor) {
  const target = actor ?? defaultActor();
  if (!target) {
    ui.notifications.warn(L("NoTarget"));
    return { ok: false, reason: "noActor" };
  }
  const result = await request("take", { ...reference, actorUuid: target.uuid });
  if (result?.ok) {
    const text = result.taken > 1
      ? F("TookMany", { qty: result.taken, name: result.name, actor: result.actorName })
      : F("TookOne", { name: result.name, actor: result.actorName });
    ui.notifications.info(text);
  } else {
    CratePopApp.notifyFailure(result);
  }
  return result;
}

/* -------------------------------------------- */
/*  Drag from the crate onto a sheet            */
/* -------------------------------------------- */

/** Find the actor a drop landed on: an open sheet, the Actors sidebar, or an owned token. */
export function findActorAtDropTarget(element, event) {
  const isActor = d => d?.documentName === "Actor";
  if (element?.closest) {
    const entry = element.closest("#actors [data-entry-id], .actors-sidebar [data-entry-id]");
    if (entry) {
      const actor = game.actors.get(entry.dataset.entryId);
      if (isActor(actor)) return actor;
    }
    const appElement = element.closest(".application, .app");
    if (appElement) {
      const app = foundry.applications.instances.get(appElement.id)
        ?? (appElement.dataset?.appid ? ui.windows?.[appElement.dataset.appid] : null);
      const doc = app?.actor ?? app?.document;
      if (isActor(doc)) return doc;
      if (doc?.documentName === "Token" && isActor(doc.actor)) return doc.actor;
    }
    if (element.closest("#board") && event && canvas?.ready) {
      try {
        const p = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
        const token = canvas.tokens.placeables.find(t => t.actor?.isOwner && !isLootToken(t.document)
          && t.bounds?.contains(p.x, p.y));
        if (token) return token.actor;
      } catch { /* not over a token */ }
    }
  }
  return null;
}

function readOurDrag(event) {
  const raw = event.dataTransfer?.getData("text/plain");
  if (!raw || !raw.includes(DRAG_TYPE)) return null;
  try {
    const data = JSON.parse(raw);
    return data?.type === DRAG_TYPE ? data : null;
  } catch {
    return null;
  }
}

/**
 * Listens before the sheet does (capture phase), so crate items never reach the system's
 * own drop code, which would copy the item without taking it out of the crate.
 */
export function onGlobalDrop(event) {
  const data = readOurDrag(event);
  if (!data) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  CratePopApp.activeDrag = null;
  if (event.target?.closest?.(`.${MODULE_ID}`)) return; // dropped back on the crate
  const actor = findActorAtDropTarget(event.target, event);
  if (!actor) {
    ui.notifications.warn(L("DropOnSheet"));
    return;
  }
  return takeTo({ sceneId: data.sceneId, tokenId: data.tokenId, entryId: data.entryId, qty: data.qty }, actor);
}

export function onGlobalDragOver(event) {
  if (!CratePopApp.activeDrag) return;
  if (findActorAtDropTarget(event.target, null) || event.target?.closest?.("#board")) event.preventDefault();
}

/* -------------------------------------------- */
/*  Service wiring                              */
/* -------------------------------------------- */

export function buildService(adapter) {
  return createLootService({
    getUser: id => {
      const u = game.users.get(id);
      return u ? { id: u.id, isGM: u.isGM, active: u.active, user: u } : null;
    },
    getToken: (sceneId, tokenId) => game.scenes.get(sceneId)?.tokens.get(tokenId) ?? null,
    isContainer: token => isLootToken(token),
    isLocked: token => !!token.getFlag(MODULE_ID, "locked"),
    isHidden: token => !!token.hidden,
    readEntries: token => token.getFlag(MODULE_ID, "items") ?? [],
    writeEntries: (token, entries) => token.update({ [`flags.${MODULE_ID}.items`]: entries }),
    writeLocked: (token, locked) => token.update({ [`flags.${MODULE_ID}.locked`]: locked }),
    getActor: async uuid => {
      const doc = uuid ? await fromUuid(uuid) : null;
      return doc?.documentName === "Actor" ? doc : null;
    },
    canOwn: (actor, user) => actor.testUserPermission(user.user, "OWNER"),
    actorItems: actor => actor.items.map(i => ({
      id: i.id, type: i.type, name: i.name, quantity: getQuantity(i.toObject(), adapter)
    })),
    applyGrant: async (actor, plan) => {
      if (plan.update) return actor.updateEmbeddedDocuments("Item", [plan.update]);
      return actor.createEmbeddedDocuments("Item", plan.create);
    },
    getItemData: async uuid => {
      const doc = await fromUuid(uuid);
      return doc?.documentName === "Item" ? doc.toObject() : null;
    },
    newId: () => foundry.utils.randomID(),
    log: (level, ...args) => console[level]?.(`${MODULE_ID} |`, ...args)
  }, adapter);
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

export function patchTokenClass(TokenClass) {
  const proto = TokenClass.prototype;
  if (proto[`${MODULE_ID}Patched`]) return;
  const canView = proto._canView;
  const clickLeft2 = proto._onClickLeft2;
  proto._canView = function (user, event) {
    if (isLootToken(this.document)) return true;
    return canView.call(this, user, event);
  };
  proto._onClickLeft2 = function (event) {
    if (isLootToken(this.document)) {
      openLoot(this.document);
      return;
    }
    return clickLeft2.call(this, event);
  };
  proto[`${MODULE_ID}Patched`] = true;
}

export function addHUDButton(hud, element) {
  if (!game.user.isGM) return;
  const tokenDocument = hud.document ?? hud.object?.document;
  if (!tokenDocument) return;
  const column = element.querySelector(".col.right") ?? element.querySelector(".col.left") ?? element;
  const active = isLootToken(tokenDocument);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `control-icon ${MODULE_ID}-hud${active ? " active" : ""}`;
  button.dataset.tooltip = active ? L("HUDRemove") : L("HUDMake");
  button.setAttribute("aria-label", button.dataset.tooltip);
  button.innerHTML = `<i class="fa-solid ${active ? "fa-box-open" : "fa-box"}"></i>`;
  button.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    await toggleCrate(tokenDocument);
    hud.render?.();
  });
  column.appendChild(button);
}

export function addSceneControl(controls) {
  const tokens = controls?.tokens ?? controls?.token;
  if (!tokens?.tools || Array.isArray(tokens.tools)) return;
  tokens.tools[`${MODULE_ID}-place`] = {
    name: `${MODULE_ID}-place`,
    title: "CRATEPOP.PlaceCrate",
    icon: "fa-solid fa-box",
    order: Object.keys(tokens.tools).length,
    button: true,
    visible: game.user.isGM,
    onChange: () => placeCrate()
  };
}

Hooks.once("init", () => {
  CONFIG.queries[QUERY] = handleQuery;

  // Backup way in: hover over a crate and press L.
  game.keybindings.register(MODULE_ID, "openHovered", {
    name: "CRATEPOP.KeyOpen",
    hint: "CRATEPOP.KeyOpenHint",
    editable: [{ key: "KeyL" }],
    onDown: () => {
      const token = canvas?.tokens?.hover;
      if (token && token.visible && isLootToken(token.document)) {
        openLoot(token.document);
        return true;
      }
      return false;
    }
  });
});

Hooks.once("setup", () => {
  patchTokenClass(CONFIG.Token.objectClass);
  const adapter = getAdapter(game.system.id);
  service = buildService(adapter);
  CratePopApp.hooks = { request, takeTo, defaultActor, adapter };
  game.modules.get(MODULE_ID).api = { openLoot, placeCrate, toggleCrate, isLootToken, adapter };
});

Hooks.once("ready", () => {
  document.addEventListener("drop", onGlobalDrop, true);
  document.addEventListener("dragover", onGlobalDragOver, true);
  const adapter = getAdapter(game.system.id);
  if (game.user.isGM && !adapter.verified) {
    console.info(`${MODULE_ID} | No adapter for "${game.system.id}"; using the generic one.`);
  }
});

Hooks.on("renderTokenHUD", addHUDButton);
Hooks.on("getSceneControlButtons", addSceneControl);

Hooks.on("updateToken", (tokenDocument, changes) => {
  if (!changes?.flags?.[MODULE_ID] && !("name" in (changes ?? {})) && !("hidden" in (changes ?? {}))) return;
  for (const app of openWindowsFor(tokenDocument)) {
    const lockedOut = !game.user.isGM && (tokenDocument.hidden || tokenDocument.getFlag(MODULE_ID, "locked"));
    if (!isLootToken(tokenDocument) || lockedOut) app.close();
    else app.render();
  }
});

Hooks.on("deleteToken", tokenDocument => {
  for (const app of openWindowsFor(tokenDocument)) app.close();
});
