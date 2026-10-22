/**
 * Hand-over tests: looting moves an item from a crate onto a sheet with nothing duplicated
 * and nothing lost. Runs the real core.js service against mock tokens and actors whose
 * item rules follow each system's schema (fixtures.mjs). Database calls are given random
 * delays so concurrent requests really interleave.
 */
import assert from "node:assert/strict";
import {
  createLootService, getAdapter, getQuantity, countUnits, normalizeEntries
} from "../scripts/core.js";
import { SYSTEMS } from "./fixtures.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => sleep(Math.random() * 4);
let idCounter = 0;
const newId = () => `id${++idCounter}`;
const clone = o => JSON.parse(JSON.stringify(o));

class MockActor {
  constructor(name, owners, validate) {
    this.name = name; this.uuid = `Actor.${name}`; this.owners = owners; this.items = []; this.validate = validate;
    this.failNext = false;
  }
  async createEmbeddedDocuments(_type, list) {
    await jitter();
    if (this.failNext) { this.failNext = false; throw new Error("database said no"); }
    for (const d of list) this.validate(d); // all-or-nothing, like one Foundry create call
    for (const d of list) this.items.push({ ...clone(d), _id: newId() });
  }
  async updateEmbeddedDocuments(_type, list) {
    await jitter();
    if (this.failNext) { this.failNext = false; throw new Error("database said no"); }
    for (const u of list) {
      const item = this.items.find(i => i._id === u._id);
      if (!item) throw new Error("no such item");
      for (const [k, v] of Object.entries(u)) {
        if (k === "_id") continue;
        const keys = k.split("."); let o = item;
        while (keys.length > 1) o = o[keys.shift()];
        o[keys[0]] = v;
      }
      this.validate(item);
    }
  }
}

class MockToken {
  constructor(id) { this.id = id; this.flags = { container: true, items: [], locked: false }; this.hidden = false; this.writes = 0; }
  async setItems(entries) { await jitter(); this.flags.items = clone(entries); this.writes++; }
}

function world(systemId) {
  const sys = SYSTEMS[systemId];
  const adapter = getAdapter(systemId);
  const users = {
    gm: { id: "gm", isGM: true, active: true },
    p1: { id: "p1", isGM: false, active: true },
    p2: { id: "p2", isGM: false, active: true },
    p3: { id: "p3", isGM: false, active: true }
  };
  const actors = {
    a1: new MockActor("Ripley", ["p1"], sys.validate),
    a2: new MockActor("Hicks", ["p2"], sys.validate),
    a3: new MockActor("Bishop", ["p3"], sys.validate)
  };
  const worldItems = Object.fromEntries(sys.items.map(i => [`Item.${i._id}`, i]));
  const token = new MockToken("tok1");
  const service = createLootService({
    getUser: id => users[id] ?? null,
    getToken: (s, t) => (s === "scene1" && t === token.id ? token : null),
    isContainer: t => !!t.flags.container,
    isLocked: t => !!t.flags.locked,
    isHidden: t => !!t.hidden,
    readEntries: t => t.flags.items,
    writeEntries: (t, e) => t.setItems(e),
    writeLocked: async (t, l) => { t.flags.locked = l; },
    getActor: async uuid => Object.values(actors).find(a => a.uuid === uuid) ?? null,
    canOwn: (actor, user) => user.isGM || actor.owners.includes(user.id),
    actorItems: actor => actor.items.map(i => ({ id: i._id, type: i.type, name: i.name, quantity: getQuantity(i, adapter) })),
    applyGrant: async (actor, plan) => plan.update
      ? actor.updateEmbeddedDocuments("Item", [plan.update])
      : actor.createEmbeddedDocuments("Item", plan.create),
    getItemData: async uuid => clone(worldItems[uuid] ?? null),
    newId,
    log: () => {}
  }, adapter);
  const call = (userId, action, payload) => service.handle({ userId, action, payload: { sceneId: "scene1", tokenId: "tok1", ...payload } });
  return { sys, adapter, users, actors, token, call, worldItems };
}

/** Units of one item name on an actor: quantity if it has one, else one per copy. */
function unitsOn(actor, name, adapter) {
  return actor.items.filter(i => i.name === name).reduce((n, i) => n + (getQuantity(i, adapter) ?? 1), 0);
}
function unitsInCrate(token, name) {
  return normalizeEntries(token.flags.items).filter(e => e.data.name === name).reduce((n, e) => n + e.qty, 0);
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); }
  catch (err) { results.push([false, name, err]); }
}

async function fill(w) {
  for (const id of Object.keys(w.worldItems)) {
    const r = await w.call("gm", "add", { uuid: id });
    assert.equal(r.ok, true, `GM add ${id}`);
  }
}

const entryFor = (w, name) => normalizeEntries(w.token.flags.items).find(e => e.data.name === name);

for (const systemId of Object.keys(SYSTEMS)) {
  await test(`${systemId}: every item moves crate -> sheet, totals conserved`, async () => {
    const w = world(systemId);
    await fill(w);
    for (const src of w.sys.items) {
      const start = unitsInCrate(w.token, src.name);
      assert.ok(start >= 1);
      const r = await w.call("p1", "take", { entryId: entryFor(w, src.name).id, qty: "all", actorUuid: w.actors.a1.uuid });
      assert.equal(r.ok, true, `take ${src.name}: ${r.reason} ${r.detail ?? ""}`);
      assert.equal(unitsInCrate(w.token, src.name), 0, `${src.name} left the crate`);
      assert.equal(unitsOn(w.actors.a1, src.name, w.adapter), start, `${src.name} arrived in full`);
    }
    assert.equal(countUnits(w.token.flags.items), 0);
  });

  await test(`${systemId}: taking one from a stack, twice, merges on the sheet where the system stacks`, async () => {
    const w = world(systemId);
    await fill(w);
    const stack = w.sys.items.find(i => (getQuantity(i, w.adapter) ?? 0) >= 2);
    if (!stack) return; // no stackable fixture in this system
    const id = entryFor(w, stack.name).id;
    const before = unitsInCrate(w.token, stack.name);
    await w.call("p2", "take", { entryId: id, qty: 1, actorUuid: w.actors.a2.uuid });
    await w.call("p2", "take", { entryId: id, qty: 1, actorUuid: w.actors.a2.uuid });
    assert.equal(unitsInCrate(w.token, stack.name), before - 2);
    assert.equal(unitsOn(w.actors.a2, stack.name, w.adapter), 2);
    const copies = w.actors.a2.items.filter(i => i.name === stack.name).length;
    const stacks = w.adapter.stackTypes === null || w.adapter.stackTypes.includes(stack.type);
    assert.equal(copies, stacks ? 1 : 2);
  });

  await test(`${systemId}: three players grab the same last item at once, exactly one gets it`, async () => {
    for (let round = 0; round < 40; round++) {
      const w = world(systemId);
      const single = w.sys.items[w.sys.items.length - 1];
      await w.call("gm", "add", { uuid: `Item.${single._id}` });
      const entry = entryFor(w, single.name);
      // Make it exactly one unit.
      if (entry.qty > 1) await w.call("gm", "adjust", { entryId: entry.id, delta: 1 - entry.qty });
      const rs = await Promise.all(["p1", "p2", "p3"].map((p, i) =>
        w.call(p, "take", { entryId: entry.id, qty: "all", actorUuid: Object.values(w.actors)[i].uuid })));
      assert.equal(rs.filter(r => r.ok).length, 1, "one winner");
      assert.ok(rs.filter(r => !r.ok).every(r => r.reason === "gone"), "losers told it's gone");
      const total = Object.values(w.actors).reduce((n, a) => n + unitsOn(a, single.name, w.adapter), 0);
      assert.equal(total, 1, "one copy in the world");
      assert.equal(countUnits(w.token.flags.items), 0);
    }
  });

  await test(`${systemId}: 200 random concurrent takes never create or destroy a unit`, async () => {
    const w = world(systemId);
    await fill(w);
    for (const e of normalizeEntries(w.token.flags.items)) await w.call("gm", "adjust", { entryId: e.id, delta: 4 });
    const names = w.sys.items.map(i => i.name);
    const startTotals = Object.fromEntries(names.map(n => [n, unitsInCrate(w.token, n)]));
    const players = [["p1", w.actors.a1], ["p2", w.actors.a2], ["p3", w.actors.a3]];
    const jobs = [];
    for (let i = 0; i < 200; i++) {
      const [p, a] = players[i % 3];
      const name = names[Math.floor(Math.random() * names.length)];
      const e = entryFor(w, name);
      const entryId = e?.id ?? "missing";
      jobs.push(w.call(p, "take", { entryId, qty: Math.random() < 0.5 ? 1 : "all", actorUuid: a.uuid }));
    }
    await Promise.all(jobs);
    for (const n of names) {
      const held = players.reduce((s, [, a]) => s + unitsOn(a, n, w.adapter), 0);
      assert.equal(held + unitsInCrate(w.token, n), startTotals[n], `${n} conserved`);
    }
  });

  await test(`${systemId}: if the sheet refuses the item, it goes back in the crate`, async () => {
    const w = world(systemId);
    await fill(w);
    const src = w.sys.items[0];
    const before = unitsInCrate(w.token, src.name);
    w.actors.a1.failNext = true;
    const r = await w.call("p1", "take", { entryId: entryFor(w, src.name).id, qty: "all", actorUuid: w.actors.a1.uuid });
    assert.equal(r.ok, false); assert.equal(r.reason, "grantFailed");
    assert.equal(unitsInCrate(w.token, src.name), before);
    assert.equal(unitsOn(w.actors.a1, src.name, w.adapter), 0);
  });

  await test(`${systemId}: players can't loot into someone else's sheet, a locked crate or a hidden one`, async () => {
    const w = world(systemId);
    await fill(w);
    const total = countUnits(w.token.flags.items);
    const id = normalizeEntries(w.token.flags.items)[0].id;
    assert.equal((await w.call("p1", "take", { entryId: id, actorUuid: w.actors.a2.uuid })).reason, "noPermission");
    w.token.flags.locked = true;
    assert.equal((await w.call("p1", "take", { entryId: id, actorUuid: w.actors.a1.uuid })).reason, "locked");
    w.token.flags.locked = false; w.token.hidden = true;
    assert.equal((await w.call("p1", "take", { entryId: id, actorUuid: w.actors.a1.uuid })).reason, "noContainer");
    assert.equal((await w.call("p1", "add", { uuid: "Item.x" })).reason, "noPermission");
    assert.equal((await w.call("p1", "remove", { entryId: id })).reason, "noPermission");
    assert.equal((await w.call("nobody", "take", { entryId: id, actorUuid: w.actors.a1.uuid })).reason, "badUser");
    assert.equal(countUnits(w.token.flags.items), total);
    assert.equal(w.actors.a1.items.length + w.actors.a2.items.length, 0);
  });
}

await test("CoC7: Keeper notes never enter the crate, and the weapon's old skill link is cleared", async () => {
  const w = world("CoC7");
  await fill(w);
  const stored = JSON.stringify(w.token.flags.items);
  for (const secret of ["Mi-Go", "cultist", "Contact Deity"]) assert.ok(!stored.includes(secret), `crate leaks ${secret}`);
  await w.call("p1", "take", { entryId: entryFor(w, ".38 Revolver").id, actorUuid: w.actors.a1.uuid });
  const gun = w.actors.a1.items.find(i => i.name === ".38 Revolver");
  assert.equal(gun.system.skill.main.id, "");
  assert.equal(gun.system.skill.main.name, "Handgun");
  assert.equal(gun.system.description.value, "Six shots.");
});

await test("Daggerheart: weapons and armour arrive unequipped; potions stack", async () => {
  const w = world("daggerheart");
  await fill(w);
  for (const n of ["Broadsword", "Leather Armor"]) await w.call("p1", "take", { entryId: entryFor(w, n).id, actorUuid: w.actors.a1.uuid });
  assert.ok(w.actors.a1.items.filter(i => ["weapon", "armor"].includes(i.type)).every(i => i.system.equipped === false));
  const pot = entryFor(w, "Minor Health Potion").id;
  await w.call("p1", "take", { entryId: pot, qty: 1, actorUuid: w.actors.a1.uuid });
  await w.call("p1", "take", { entryId: pot, qty: "all", actorUuid: w.actors.a1.uuid });
  const pots = w.actors.a1.items.filter(i => i.name === "Minor Health Potion");
  assert.equal(pots.length, 1); assert.equal(pots[0].system.quantity, 4);
});

await test("Mothership: two pulse rifles become two separate weapons with no quantity field", async () => {
  const w = world("mosh");
  await w.call("gm", "add", { uuid: "Item.m2" });
  await w.call("gm", "add", { uuid: "Item.m2" });
  const e = entryFor(w, "Pulse Rifle");
  assert.equal(e.qty, 2);
  await w.call("p1", "take", { entryId: e.id, qty: "all", actorUuid: w.actors.a1.uuid });
  const rifles = w.actors.a1.items.filter(i => i.name === "Pulse Rifle");
  assert.equal(rifles.length, 2);
  assert.ok(rifles.every(r => !("quantity" in r.system)));
});

await test("dnd5e: the old container link is cleared", async () => {
  const w = world("dnd5e");
  await fill(w);
  await w.call("p1", "take", { entryId: entryFor(w, "Potion of Healing").id, actorUuid: w.actors.a1.uuid });
  assert.equal(w.actors.a1.items[0].system.container, null);
});

// Control: a naive version without the queue DOES duplicate, so the race tests can catch it.
await test("control: without the GM queue, simultaneous grabs duplicate the item", async () => {
  let dupes = 0;
  for (let round = 0; round < 20; round++) {
    const token = { items: [{ id: "x", qty: 1, data: { name: "Medkit" } }] };
    const got = [];
    await Promise.all([1, 2, 3].map(async p => {
      const entry = token.items.find(e => e.id === "x");
      await jitter();
      if (!entry) return;
      token.items = token.items.filter(e => e.id !== "x");
      got.push(p);
    }));
    if (got.length > 1) dupes++;
  }
  assert.ok(dupes > 0, "naive version should have duplicated at least once");
});

const failed = results.filter(r => !r[0]);
for (const [ok, name, err] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${err ? `\n      ${err.message}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
