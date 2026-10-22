/**
 * Crate Pop: core logic.
 *
 * This file has no Foundry globals in it, so it can be tested outside Foundry.
 * Everything that touches Foundry is passed in as a dependency (see createLootService).
 */

export const MODULE_ID = "crate-pop";
export const DRAG_TYPE = "CratePopEntry";

/* -------------------------------------------- */
/*  Small helpers                               */
/* -------------------------------------------- */

export function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function getProp(obj, path) {
  return path.split(".").reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

export function hasProp(obj, path) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys) {
    if (o === null || typeof o !== "object" || !(k in o)) return false;
    o = o[k];
  }
  return true;
}

export function setProp(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] === null || typeof o[keys[i]] !== "object") o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

function toCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/* -------------------------------------------- */
/*  System adapters                             */
/* -------------------------------------------- */

/**
 * An adapter describes the few places where game systems differ for looting:
 * - quantityPath: where an item keeps its stack count (if it has one)
 * - stackTypes:   item types that merge into an existing stack on the receiving sheet
 *                 (null means "any item that has a quantity")
 * - resetOnGrant: fields set on the copy the player receives, only if the field exists
 *                 (for example "not equipped", or links to the old owner's items)
 * - gmOnly:       fields wiped when an item goes into a crate, because crate contents
 *                 are visible to every player's browser (for example Keeper notes)
 * - verified:     true only for adapters whose handoff has been run through the test suite
 *                 against that system's item schema. It is not a claim of live testing.
 */
const GENERIC = {
  id: "generic",
  label: "Generic (any other system)",
  quantityPath: "system.quantity",
  stackTypes: null,
  resetOnGrant: {},
  gmOnly: [],
  verified: false
};

export const ADAPTERS = {
  generic: GENERIC,

  // Mothership (MoSh, id "mosh"). Only item, repair and module carry a quantity.
  // Weapons and armour have none, so each one is a separate item.
  mosh: {
    ...GENERIC,
    id: "mosh",
    label: "Mothership (MoSh)",
    stackTypes: ["item", "repair", "module"],
    verified: true
  },

  // Call of Cthulhu 7th Edition (id "CoC7"). Only the "item" type has a quantity.
  // Weapons point at a skill by id on the old owner, so the id is cleared and
  // the skill name is kept. Keeper notes never go into a crate.
  CoC7: {
    ...GENERIC,
    id: "CoC7",
    label: "Call of Cthulhu 7th Edition",
    stackTypes: ["item"],
    resetOnGrant: {
      "system.skill.main.id": "",
      "system.skill.alternativ.id": ""
    },
    gmOnly: ["system.description.keeper"],
    verified: true
  },

  // Daggerheart (id "daggerheart"). loot, consumable, weapon and armor all have a
  // quantity. Loot and consumables merge; weapons and armour arrive unequipped.
  daggerheart: {
    ...GENERIC,
    id: "daggerheart",
    label: "Daggerheart",
    stackTypes: ["loot", "consumable"],
    resetOnGrant: { "system.equipped": false },
    verified: true
  },

  // D&D 5th Edition (id "dnd5e"). Clears the link to a container on the old owner.
  dnd5e: {
    ...GENERIC,
    id: "dnd5e",
    label: "D&D 5th Edition",
    stackTypes: ["consumable", "loot"],
    resetOnGrant: { "system.equipped": false, "system.attuned": false, "system.container": null },
    verified: true
  }
};

export function getAdapter(systemId) {
  return ADAPTERS[systemId] ?? GENERIC;
}

export function getQuantity(itemData, adapter = GENERIC) {
  if (!hasProp(itemData, adapter.quantityPath)) return null;
  return toCount(getProp(itemData, adapter.quantityPath));
}

export function canStack(itemData, adapter = GENERIC) {
  if (getQuantity(itemData, adapter) === null) return false;
  if (adapter.stackTypes === null) return true;
  return adapter.stackTypes.includes(itemData.type);
}

/** Clean an item's data before it is stored in a crate. */
export function sanitizeForStorage(itemData, adapter = GENERIC) {
  const data = clone(itemData) ?? {};
  for (const key of ["_id", "folder", "sort", "ownership", "_stats"]) delete data[key];
  for (const path of adapter.gmOnly) {
    if (hasProp(data, path)) setProp(data, path, "");
  }
  if (getQuantity(data, adapter) !== null) setProp(data, adapter.quantityPath, 1);
  return data;
}

/** Build the copy a player receives. */
export function prepareForGrant(itemData, adapter = GENERIC) {
  const data = sanitizeForStorage(itemData, adapter);
  for (const [path, value] of Object.entries(adapter.resetOnGrant)) {
    if (hasProp(data, path)) setProp(data, path, value);
  }
  return data;
}

/* -------------------------------------------- */
/*  Crate contents                              */
/* -------------------------------------------- */

/** Crate contents are an array of { id, qty, data }. Anything malformed is dropped. */
export function normalizeEntries(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(e => e && typeof e.id === "string" && e.data && typeof e.data === "object")
    .map(e => ({ id: e.id, qty: Math.max(1, Math.floor(toCount(e.qty) ?? 1)), data: e.data }));
}

export function countUnits(entries) {
  return normalizeEntries(entries).reduce((n, e) => n + e.qty, 0);
}

function sameKind(a, b, adapter) {
  return a.type === b.type && a.name === b.name && (a.img ?? "") === (b.img ?? "")
    && (getQuantity(a, adapter) === null) === (getQuantity(b, adapter) === null);
}

/** Add an item to a crate. A matching item (same type, name and picture) just grows its count. */
export function addEntry(entries, itemData, adapter, newId) {
  const list = normalizeEntries(clone(entries));
  const qty = Math.max(1, Math.floor(getQuantity(itemData, adapter) ?? 1));
  const data = sanitizeForStorage(itemData, adapter);
  const match = list.find(e => sameKind(e.data, data, adapter));
  if (match) match.qty += qty;
  else list.push({ id: newId(), qty, data });
  return list;
}

/** Remove up to `requested` units of one entry. Returns the new list and what was taken. */
export function takeFromEntries(entries, entryId, requested) {
  const list = normalizeEntries(clone(entries));
  const index = list.findIndex(e => e.id === entryId);
  if (index === -1) return { ok: false, reason: "gone" };
  const entry = list[index];
  let want = requested === "all" ? entry.qty : Math.floor(toCount(requested) ?? 0);
  if (want < 1) return { ok: false, reason: "badQuantity" };
  const taken = Math.min(want, entry.qty);
  if (taken === entry.qty) list.splice(index, 1);
  else entry.qty -= taken;
  return { ok: true, entries: list, taken, entry: { id: entry.id, data: clone(entry.data) } };
}

/** Put units back (used when giving the item to the player failed). */
export function restoreToEntries(entries, entry, amount) {
  const list = normalizeEntries(clone(entries));
  const match = list.find(e => e.id === entry.id);
  if (match) match.qty += amount;
  else list.push({ id: entry.id, qty: amount, data: clone(entry.data) });
  return list;
}

export function adjustEntry(entries, entryId, delta) {
  const list = normalizeEntries(clone(entries));
  const index = list.findIndex(e => e.id === entryId);
  if (index === -1) return { ok: false, reason: "gone" };
  list[index].qty += Math.trunc(delta);
  if (list[index].qty < 1) list.splice(index, 1);
  return { ok: true, entries: list };
}

/**
 * Work out how to give `amount` units to an actor.
 * Returns either { update } (grow an existing stack) or { create: [...] }, never both,
 * so the hand-over is a single database operation.
 */
export function buildGrantPlan(entryData, amount, actorItems, adapter) {
  const data = prepareForGrant(entryData, adapter);
  if (getQuantity(data, adapter) !== null) {
    if (canStack(data, adapter)) {
      const existing = actorItems.find(i => i.type === data.type && i.name === data.name && i.quantity !== null);
      if (existing) return { update: { _id: existing.id, [adapter.quantityPath]: existing.quantity + amount } };
    }
    setProp(data, adapter.quantityPath, amount);
    return { create: [data] };
  }
  return { create: Array.from({ length: amount }, () => clone(data)) };
}

/* -------------------------------------------- */
/*  Serialized, GM-side loot service            */
/* -------------------------------------------- */

/** Runs jobs one at a time, in the order they arrive, even if one fails. */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return job => {
    const run = tail.then(job, job);
    tail = run.catch(() => {});
    return run;
  };
}

const fail = (reason, detail) => ({ ok: false, reason, ...(detail ? { detail } : {}) });

/**
 * The service only runs on the active GM's browser. Players ask it to act; it checks
 * the request, changes the crate, and gives the item, one request at a time.
 *
 * deps:
 *   getUser(id) -> { id, isGM, active } | null
 *   getToken(sceneId, tokenId) -> token document | null
 *   isContainer(token), isLocked(token), isHidden(token) -> boolean
 *   readEntries(token) -> array
 *   writeEntries(token, entries) -> Promise
 *   writeLocked(token, locked) -> Promise
 *   getActor(uuid) -> Promise<actor | null>
 *   canOwn(actor, user) -> boolean
 *   actorItems(actor) -> [{ id, type, name, quantity }]  (quantity null if none)
 *   applyGrant(actor, plan) -> Promise
 *   getItemData(uuid) -> Promise<object | null>
 *   newId() -> string
 *   log(level, ...args)
 */
export function createLootService(deps, adapter) {
  const enqueue = createSerialQueue();
  const log = deps.log ?? (() => {});

  async function take(user, p) {
    const token = deps.getToken(p.sceneId, p.tokenId);
    if (!token || !deps.isContainer(token)) return fail("noContainer");
    if (!user.isGM) {
      if (deps.isHidden(token)) return fail("noContainer");
      if (deps.isLocked(token)) return fail("locked");
    }
    const actor = await deps.getActor(p.actorUuid);
    if (!actor) return fail("noActor");
    if (!deps.canOwn(actor, user)) return fail("noPermission");

    const result = takeFromEntries(deps.readEntries(token), p.entryId, p.qty ?? "all");
    if (!result.ok) return result;

    // 1. Take it out of the crate first, so it can never exist in two places.
    await deps.writeEntries(token, result.entries);

    // 2. Give it to the player. If that fails, put it back, so nothing is lost.
    try {
      const plan = buildGrantPlan(result.entry.data, result.taken, deps.actorItems(actor), adapter);
      await deps.applyGrant(actor, plan);
    } catch (err) {
      log("warn", "Giving the item failed, putting it back in the crate.", err);
      try {
        await deps.writeEntries(token, restoreToEntries(deps.readEntries(token), result.entry, result.taken));
      } catch (restoreErr) {
        log("error", "Could not put the item back. Its data follows so you can recreate it.",
          result.entry.data, result.taken, restoreErr);
        return fail("lost", String(restoreErr?.message ?? restoreErr));
      }
      return fail("grantFailed", String(err?.message ?? err));
    }
    return { ok: true, taken: result.taken, name: result.entry.data.name, actorName: actor.name };
  }

  async function gmOnly(user, p, fn) {
    if (!user.isGM) return fail("noPermission");
    const token = deps.getToken(p.sceneId, p.tokenId);
    if (!token || !deps.isContainer(token)) return fail("noContainer");
    return fn(token);
  }

  const actions = {
    take,
    add: (user, p) => gmOnly(user, p, async token => {
      const itemData = await deps.getItemData(p.uuid);
      if (!itemData) return fail("noItem");
      await deps.writeEntries(token, addEntry(deps.readEntries(token), itemData, adapter, deps.newId));
      return { ok: true, name: itemData.name };
    }),
    adjust: (user, p) => gmOnly(user, p, async token => {
      const result = adjustEntry(deps.readEntries(token), p.entryId, p.delta);
      if (!result.ok) return result;
      await deps.writeEntries(token, result.entries);
      return { ok: true };
    }),
    remove: (user, p) => gmOnly(user, p, async token => {
      const list = normalizeEntries(deps.readEntries(token));
      await deps.writeEntries(token, list.filter(e => e.id !== p.entryId));
      return { ok: true };
    }),
    lock: (user, p) => gmOnly(user, p, async token => {
      await deps.writeLocked(token, !!p.locked);
      return { ok: true };
    })
  };

  return {
    /** Handle one request: { action, payload, userId }. Requests run strictly one at a time. */
    handle(request) {
      return enqueue(async () => {
        const user = deps.getUser(request?.userId);
        if (!user || !user.active) return fail("badUser");
        const action = actions[request?.action];
        if (!action) return fail("badAction");
        try {
          return await action(user, request.payload ?? {});
        } catch (err) {
          log("error", "Loot request failed.", err);
          return fail("error", String(err?.message ?? err));
        }
      });
    }
  };
}
