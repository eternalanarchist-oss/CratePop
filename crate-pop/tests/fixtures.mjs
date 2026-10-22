/**
 * Item data shaped like each system's real item schema, taken from the systems' source:
 * - Mothership: Futil/foundry-mothership template.json (item/repair/module have quantity;
 *   weapon and armor do not)
 * - Call of Cthulhu 7e: Miskatonic-Investigative-Society/CoC7-FoundryVTT models/item
 *   (item has quantity; weapon has skill.main.id / skill.alternativ.id; Keeper notes live in
 *   description.keeper)
 * - Daggerheart: Foundryborne/daggerheart data/item (loot, consumable, weapon, armor all
 *   have an integer quantity >= 0; weapon and armor have equipped)
 * - D&D 5e: foundryvtt/dnd5e physical item template (quantity, container id, equipped)
 */

export const SYSTEMS = {
  mosh: {
    items: [
      { _id: "m1", name: "Medkit", type: "item", img: "icons/medkit.webp", system: { description: "Heals.", quantity: 3, weight: 1, cost: 1500 } },
      { _id: "m2", name: "Pulse Rifle", type: "weapon", img: "icons/rifle.webp", system: { damage: "3d10", shots: 5, ranges: { short: 10 }, cost: 2400 } },
      { _id: "m3", name: "Vaccsuit", type: "armor", img: "icons/suit.webp", system: { armorPoints: 3, oxygenCurrent: 60 } }
    ],
    validate(item) {
      if (["weapon", "armor"].includes(item.type) && item.system && "quantity" in item.system) {
        throw new Error(`Mothership ${item.type} has no quantity field`);
      }
      if (["item", "repair", "module"].includes(item.type) && typeof item.system.quantity !== "number") {
        throw new Error("Mothership item quantity must be a number");
      }
    }
  },

  CoC7: {
    items: [
      { _id: "c1", name: "Flashlight", type: "item", img: "icons/torch.webp", system: { quantity: 2, weight: 0.5, description: { value: "A torch.", keeper: "It flickers near the Mi-Go." } } },
      { _id: "c2", name: ".38 Revolver", type: "weapon", img: "icons/revolver.webp", system: { skill: { main: { id: "SKILLID123", name: "Handgun" }, alternativ: { id: "", name: "" } }, range: { normal: { value: 15 } }, description: { value: "Six shots.", keeper: "Belonged to the cultist." } } },
      { _id: "c3", name: "Necronomicon", type: "book", img: "icons/book.webp", system: { description: { value: "Bound in skin.", keeper: "Grants Contact Deity." } } }
    ],
    validate(item) {
      if (item.type === "item" && typeof item.system.quantity !== "number") throw new Error("CoC7 item quantity must be a number");
      if (item.type !== "item" && item.system && "quantity" in item.system) throw new Error(`CoC7 ${item.type} has no quantity`);
    }
  },

  daggerheart: {
    items: [
      { _id: "d1", name: "Minor Health Potion", type: "consumable", img: "icons/potion.webp", system: { quantity: 4, description: "Clear 1d4 HP." } },
      { _id: "d2", name: "Broadsword", type: "weapon", img: "icons/sword.webp", system: { quantity: 1, equipped: true, tier: 1, description: "" } },
      { _id: "d3", name: "Leather Armor", type: "armor", img: "icons/armor.webp", system: { quantity: 1, equipped: true, baseScore: 3 } },
      { _id: "d4", name: "Glowing Rune", type: "loot", img: "icons/rune.webp", system: { quantity: 2 } }
    ],
    validate(item) {
      const q = item.system?.quantity;
      if (!Number.isInteger(q) || q < 0) throw new Error("Daggerheart quantity must be an integer >= 0");
    }
  },

  dnd5e: {
    items: [
      { _id: "e1", name: "Potion of Healing", type: "consumable", img: "icons/potion.webp", system: { quantity: 2, container: "BAG01", equipped: false } },
      { _id: "e2", name: "Longsword", type: "weapon", img: "icons/longsword.webp", system: { quantity: 1, container: null, equipped: true, attuned: false } }
    ],
    validate(item) {
      if (typeof item.system?.quantity !== "number") throw new Error("dnd5e quantity must be a number");
    }
  },

  // A made-up system with no adapter, to check the generic fallback.
  "some-other-system": {
    items: [
      { _id: "g1", name: "Rope", type: "gear", img: "icons/rope.webp", system: { quantity: 1 } },
      { _id: "g2", name: "Idol", type: "treasure", img: "icons/idol.webp", system: { value: 50 } }
    ],
    validate() {}
  }
};
