/**
 * Smoke test of main.js and crate-app.js against a mock of the Foundry 13/14 client API.
 * This checks the wiring (hooks, token patch, GM query routing, drag-and-drop routing,
 * HUD and scene-control buttons, window HTML). It is not a live Foundry run.
 */
import assert from "node:assert/strict";
import { SYSTEMS } from "./fixtures.mjs";

const SYSTEM = process.argv[2] ?? "mosh";
const clone = o => JSON.parse(JSON.stringify(o));
let n = 0;
const randomID = () => `r${++n}`;

// ---------- mock Foundry ----------
const hooks = { on: {}, once: {} };
globalThis.Hooks = {
  on: (k, fn) => ((hooks.on[k] ??= []).push(fn)),
  once: (k, fn) => ((hooks.once[k] ??= []).push(fn))
};
const instances = new Map();
class ApplicationV2 {
  constructor(options = {}) { this.options = options; this.id = options.id; this.element = null; }
  async render() {
    instances.set(this.id, this);
    const ctx = await this._prepareContext({});
    this.lastHTML = await this._renderHTML(ctx, {});
    return this;
  }
  async close() { instances.delete(this.id); this.closed = true; }
}
globalThis.foundry = { applications: { api: { ApplicationV2 }, instances }, utils: { randomID } };
globalThis.CONST = { GRID_SNAPPING_MODES: { TOP_LEFT_CORNER: 1 }, TOKEN_DISPLAY_MODES: { HOVER: 30 }, TOKEN_DISPOSITIONS: { NEUTRAL: 0 } };
const notes = [];
globalThis.ui = { notifications: { info: m => notes.push(["info", m]), warn: m => notes.push(["warn", m]) }, windows: {} };

const en = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../lang/en.json", import.meta.url), "utf8"));
const lookup = k => k.split(".").reduce((o, p) => o?.[p], en);

class Token { _canView() { return false; } _onClickLeft2() { this.sheetOpened = true; } }
globalThis.CONFIG = { queries: {}, Token: { objectClass: Token } };

const sys = SYSTEMS[SYSTEM];
const users = new Map();
const mkUser = (id, isGM) => ({ id, isGM, active: true, character: null, get isSelf() { return game.user.id === id; }, query: null });
const gmUser = mkUser("gm", true), p1 = mkUser("p1", false), p2 = mkUser("p2", false);
for (const u of [gmUser, p1, p2]) users.set(u.id, u);

class MockActor {
  constructor(id, name, owner) {
    this.id = id; this.name = name; this.uuid = `Actor.${id}`; this.owner = owner; this.documentName = "Actor";
    this._items = []; this.hasPlayerOwner = true;
  }
  get isOwner() { return game.user.isGM || game.user.id === this.owner; }
  testUserPermission(user, level) { return level === "OWNER" && (user.isGM || user.id === this.owner); }
  get items() { return this._items.map(d => ({ id: d._id, type: d.type, name: d.name, toObject: () => clone(d) })); }
  async createEmbeddedDocuments(t, list) { for (const d of list) { sys.validate(d); this._items.push({ ...clone(d), _id: randomID() }); } }
  async updateEmbeddedDocuments(t, list) {
    for (const u of list) { const it = this._items.find(i => i._id === u._id); it.system.quantity = u["system.quantity"]; sys.validate(it); }
  }
}
const actorA = new MockActor("A", "Ripley", "p1"), actorB = new MockActor("B", "Hicks", "p2");

class MockTokenDoc {
  constructor(id, flags) { this.id = id; this.name = "Crate"; this.hidden = false; this.flags = { "crate-pop": flags }; this.parent = { id: "S1" }; }
  getFlag(scope, key) { return this.flags[scope]?.[key]; }
  async update(changes) {
    for (const [k, v] of Object.entries(changes)) {
      const keys = k.split("."); let o = this; while (keys.length > 1) { const p = keys.shift(); o = (o[p] ??= {}); } o[keys[0]] = clone(v);
    }
    for (const fn of hooks.on.updateToken ?? []) fn(this, { flags: { "crate-pop": {} } });
  }
}
const crate = new MockTokenDoc("T1", { container: true, items: [], locked: false });
const plain = new MockTokenDoc("T2", {});
const scene = { id: "S1", tokens: new Map([["T1", crate], ["T2", plain]]) };
const worldItems = new Map(sys.items.map(i => [`Item.${i._id}`, { documentName: "Item", toObject: () => clone(i), name: i.name }]));

const keybindings = [];
const modules = new Map([["crate-pop", {}]]);
globalThis.game = {
  user: gmUser,
  system: { id: SYSTEM },
  users: Object.assign(users, { get activeGM() { return gmUser; } }),
  scenes: new Map([["S1", scene]]),
  actors: Object.assign(new Map([["A", actorA], ["B", actorB]]), { find(fn) { return [...this.values()].find(fn); } }),
  i18n: {
    localize: k => lookup(k) ?? k,
    has: k => lookup(k) !== undefined,
    format: (k, d) => (lookup(k) ?? k).replace(/\{(\w+)\}/g, (_, x) => d[x])
  },
  keybindings: { register: (...a) => keybindings.push(a) },
  modules
};
globalThis.fromUuid = async uuid => worldItems.get(uuid) ?? [actorA, actorB].find(a => a.uuid === uuid) ?? null;
const docListeners = {};
globalThis.document = {
  addEventListener: (t, fn, cap) => ((docListeners[t] ??= []).push([fn, cap])),
  createElement: () => ({ dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, fn) { this.click = fn; } })
};
globalThis.canvas = { ready: true, tokens: { controlled: [], hover: null, placeables: [] }, scene: null };

// ---------- load the module ----------
const main = await import("../scripts/main.js");
const { renderCrateHTML, CratePopApp } = await import("../scripts/crate-app.js");

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); } catch (err) { results.push([false, name, err]); }
}
const asUser = async (u, fn) => { const prev = game.user; game.user = u; try { return await fn(); } finally { game.user = prev; } };

// Player queries reach the GM's handler as they would over the socket.
for (const p of [p1, p2]) p.query = null;
gmUser.query = async (name, data) => asUser(gmUser, () => CONFIG.queries[name](clone(data)));

await test("registers its hooks", async () => {
  for (const k of ["init", "setup", "ready"]) assert.ok(hooks.once[k]?.length, k);
  for (const k of ["renderTokenHUD", "getSceneControlButtons", "updateToken", "deleteToken"]) assert.ok(hooks.on[k]?.length, k);
  for (const k of ["init", "setup", "ready"]) for (const fn of hooks.once[k]) fn();
});

await test("init: registers the GM query and the L key", async () => {
  assert.equal(typeof CONFIG.queries["crate-pop.request"], "function");
  assert.equal(keybindings[0][0], "crate-pop");
  assert.equal(keybindings[0][2].editable[0].key, "KeyL");
});

await test("ready: drop and dragover listeners use the capture phase", async () => {
  assert.equal(docListeners.drop[0][1], true);
  assert.equal(docListeners.dragover[0][1], true);
});

await test("setup: exposes the API with the right adapter", async () => {
  const api = modules.get("crate-pop").api;
  assert.equal(typeof api.openLoot, "function");
  assert.equal(api.adapter.id, ["mosh", "CoC7", "daggerheart", "dnd5e"].includes(SYSTEM) ? SYSTEM : "generic");
});

await test("GM fills the crate by drop (goes through the GM queue)", async () => {
  for (const uuid of worldItems.keys()) {
    const r = await main.request("add", { sceneId: "S1", tokenId: "T1", uuid });
    assert.equal(r.ok, true, r.reason);
  }
  assert.equal(crate.flags["crate-pop"].items.length, sys.items.length);
});

await test("token patch: players can double-click a crate, other tokens behave as before", async () => {
  const t1 = new Token(); t1.document = crate;
  const t2 = new Token(); t2.document = plain;
  await asUser(p1, async () => {
    assert.equal(t1._canView(p1), true);
    assert.equal(t2._canView(p1), false);
    t1._onClickLeft2({});
    assert.ok(instances.has(CratePopApp.idFor(crate)), "crate window opened");
    assert.ok(!t1.sheetOpened);
    t2._onClickLeft2({});
    assert.equal(t2.sheetOpened, true);
  });
});

await test("window: first render plays the opening, later renders don't", async () => {
  const app = instances.get(CratePopApp.idFor(crate));
  assert.match(app.lastHTML, /cp-opening/);
  await app.render();
  assert.match(app.lastHTML, /cp-open"/);
  assert.ok(app.options.classes.includes(SYSTEM), "system class for native styling");
});

await test("window: drop listeners are added once, not on every re-render", async () => {
  const app = instances.get(CratePopApp.idFor(crate));
  const counts = {};
  app.element = { querySelectorAll: () => [], addEventListener: t => (counts[t] = (counts[t] ?? 0) + 1), classList: { add() {}, remove() {} } };
  await app._onRender({}, {});
  await app._onRender({}, {});
  await app._onRender({}, {});
  assert.equal(counts.drop, 1);
  assert.equal(counts.dragover, 1);
});

await test("player Take button: query goes to the GM, item lands on their character", async () => {
  p1.character = actorA;
  const entry = crate.flags["crate-pop"].items[0];
  const r = await asUser(p1, () => main.takeTo({ sceneId: "S1", tokenId: "T1", entryId: entry.id, qty: "all" }, null));
  assert.equal(r.ok, true, r.reason);
  assert.ok(actorA._items.some(i => i.name === entry.data.name));
  assert.ok(!crate.flags["crate-pop"].items.some(e => e.id === entry.id));
});

await test("drag onto a sheet (ApplicationV2 sheet) gives it to that sheet's actor", async () => {
  const entry = crate.flags["crate-pop"].items[0];
  instances.set("sheet-B", { actor: actorB });
  let stopped = false;
  const target = { closest: sel => (sel.startsWith(".application") ? { id: "sheet-B", dataset: {} } : null) };
  const event = {
    target, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() { stopped = true; },
    dataTransfer: { getData: () => JSON.stringify({ type: "CratePopEntry", sceneId: "S1", tokenId: "T1", entryId: entry.id, qty: "all" }) }
  };
  const r = await asUser(p2, () => main.onGlobalDrop(event));
  assert.equal(stopped, true, "system sheet never sees the drop");
  assert.equal(r.ok, true, r.reason);
  assert.ok(actorB._items.some(i => i.name === entry.data.name));
});

await test("drag onto an old-style (v1) sheet and onto the Actors sidebar", async () => {
  if (crate.flags["crate-pop"].items.length === 0) await main.request("add", { sceneId: "S1", tokenId: "T1", uuid: [...worldItems.keys()][0] });
  await main.request("adjust", { sceneId: "S1", tokenId: "T1", entryId: crate.flags["crate-pop"].items[0].id, delta: 3 });
  const entry = crate.flags["crate-pop"].items[0];
  ui.windows[42] = { actor: actorA };
  const v1 = { closest: sel => (sel.startsWith(".application") ? { id: "app-42", dataset: { appid: "42" } } : null) };
  const side = { closest: sel => (sel.startsWith("#actors") ? { dataset: { entryId: "A" } } : null) };
  for (const target of [v1, side]) {
    const ev = { target, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
      dataTransfer: { getData: () => JSON.stringify({ type: "CratePopEntry", sceneId: "S1", tokenId: "T1", entryId: entry.id, qty: 1 }) } };
    const r = await asUser(p1, () => main.onGlobalDrop(ev));
    assert.equal(r.ok, true, r.reason);
  }
});

await test("a player dropping onto someone else's sheet is refused and nothing moves", async () => {
  const before = JSON.stringify(crate.flags["crate-pop"].items);
  const entry = crate.flags["crate-pop"].items[0];
  const ev = { target: { closest: sel => (sel.startsWith(".application") ? { id: "sheet-B", dataset: {} } : null) },
    preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
    dataTransfer: { getData: () => JSON.stringify({ type: "CratePopEntry", sceneId: "S1", tokenId: "T1", entryId: entry.id, qty: "all" }) } };
  const itemsB = actorB._items.length;
  const r = await asUser(p1, () => main.onGlobalDrop(ev));
  assert.equal(r.reason, "noPermission");
  assert.equal(JSON.stringify(crate.flags["crate-pop"].items), before);
  assert.equal(actorB._items.length, itemsB);
});

await test("ordinary item drags are left alone", async () => {
  let touched = false;
  const ev = { target: {}, preventDefault() { touched = true; }, stopPropagation() { touched = true; },
    dataTransfer: { getData: () => JSON.stringify({ type: "Item", uuid: "Item.x" }) } };
  main.onGlobalDrop(ev);
  assert.equal(touched, false);
});

await test("a GM who isn't the active GM refuses to handle requests", async () => {
  const gm2 = mkUser("gm2", true);
  const r = await asUser(gm2, () => main.handleQuery({ action: "take", payload: {}, userId: "p1" }));
  assert.equal(r.reason, "notActiveGM");
});

await test("locked crate: players can't open it", async () => {
  for (const app of [...instances.values()]) if (app instanceof CratePopApp) await app.close();
  await main.request("lock", { sceneId: "S1", tokenId: "T1", locked: true });
  const app = await asUser(p1, async () => main.openLoot(crate));
  assert.equal(app, null);
  await main.request("lock", { sceneId: "S1", tokenId: "T1", locked: false });
});

await test("Token HUD button and scene control button", async () => {
  const appended = [];
  const el = { querySelector: s => (s === ".col.right" ? { appendChild: b => appended.push(b) } : null) };
  main.addHUDButton({ document: plain, render() {} }, el);
  assert.equal(appended.length, 1);
  await appended[0].click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(main.isLootToken(plain), true, "HUD toggles a token into a crate");
  const controls = { tokens: { tools: { select: {} } } };
  main.addSceneControl(controls);
  assert.equal(controls.tokens.tools["crate-pop-place"].button, true);
});

await test("window HTML escapes item names and shows the right buttons", async () => {
  const entries = [{ id: "e1", index: 0, name: "<img src=x onerror=alert(1)>", img: "a.png", qty: 3 }];
  const player = await asUser(p1, async () => renderCrateHTML({ isGM: false, locked: false, opening: true, target: actorA, entries }));
  assert.ok(!player.includes("<img src=x"));
  assert.match(player, /data-action="take"/); assert.match(player, /data-action="takeOne"/);
  assert.match(player, /draggable="true"/);
  const gm = renderCrateHTML({ isGM: true, locked: true, opening: false, target: null, entries });
  assert.match(gm, /data-action="remove"/); assert.match(gm, /fa-lock"/);
});

await test("every user-facing string exists in en.json", async () => {
  const fs = await import("node:fs/promises");
  const src = ["main.js", "crate-app.js"].map(f => new URL(`../scripts/${f}`, import.meta.url));
  const text = (await Promise.all(src.map(u => fs.readFile(u, "utf8")))).join("\n");
  const keys = new Set([...text.matchAll(/\b[LF]\("([A-Za-z.]+)"/g)].map(m => m[1]));
  for (const m of text.matchAll(/"CRATEPOP\.([A-Za-z.]+)"/g)) keys.add(m[1]);
  for (const k of keys) assert.ok(lookup(`CRATEPOP.${k}`) !== undefined, `missing CRATEPOP.${k}`);
  for (const r of ["gone", "locked", "noGM", "timeout", "noPermission", "noActor", "noContainer", "grantFailed", "lost", "badUser"].filter(r => r !== "badUser")) {
    assert.ok(lookup(`CRATEPOP.Errors.${r}`), r);
  }
});

const failed = results.filter(r => !r[0]);
for (const [ok, name, err] of results) console.log(`${ok ? "PASS" : "FAIL"}  [${SYSTEM}] ${name}${err ? `\n      ${err.stack?.split("\n").slice(0, 3).join("\n      ")}` : ""}`);
console.log(`\n[${SYSTEM}] ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
