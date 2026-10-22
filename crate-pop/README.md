# Crate Pop

Crate Pop puts loot crates on your Foundry map. You fill a crate with items, and players double-click it to open it. They take what they want with a button or by dragging it onto their character sheet. Everyone shares the same crate, so once an item is taken it's gone for everyone else.

It's built for Foundry 14 and also loads on Foundry 13.

## Install

1. Unzip the download. You get a folder called `crate-pop`.
2. Put that folder in your Foundry data folder under `Data/modules/`, so you end up with `Data/modules/crate-pop/module.json`.
3. Restart Foundry, open your world, and tick **Crate Pop** under **Manage Modules**.

If you're on The Forge or another host, use its "upload a module" option with the zip from step 1.

## Using it as the GM

- **Place a crate:** in the Token controls on the left, click the box button (**Place a loot crate**). A crate appears in the middle of your view. It doesn't need an actor.
- **Turn any token into a crate:** right-click the token and click the box button in its menu. Click it again to turn it back.
- **Fill it:** double-click the crate to open it, then drag items in from the Items sidebar, a compendium or any sheet. Dragging the same item in again adds one to its count. Items dragged from a sheet are copied, not moved.
- **Change it:** use the minus, plus and bin buttons next to each item.
- **Lock it:** the button at the bottom of the window locks the crate. Players can't open a locked crate, and they can't see a hidden one.

## Using it as a player

- Double-click a crate to open it. The lid swings open and the items rise out.
- **Take** gives the item to your character. **Take 1** takes one from a stack. The window says which character the item goes to.
- Or drag an item onto any character sheet you own, onto your character in the Actors sidebar, or onto your token.
- If double-clicking does nothing, hover over the crate and press **L**. You can change that key under **Configure Controls**.

A GM has to be logged in, because the GM's browser does the handing out. That's what stops two players grabbing the same item at once: requests are dealt with one at a time, and the item leaves the crate before it reaches the sheet. If the sheet refuses the item, it goes back in the crate.

## Supported systems

Game systems store items differently, so Crate Pop has a small adapter for each system it knows.

| System | What the adapter does |
|---|---|
| Mothership (`mosh`) | Items, repairs and modules stack by quantity. Weapons and armour have no quantity, so each one arrives as its own item. |
| Call of Cthulhu 7th Edition (`CoC7`) | Items stack. Keeper notes are wiped when something goes into a crate, so players can't see them. A weapon's link to the old owner's skill is cleared, and the skill name is kept. |
| Daggerheart (`daggerheart`) | Loot and consumables stack. Weapons and armour arrive unequipped. |
| D&D 5th Edition (`dnd5e`) | Consumables and loot stack. Items arrive unequipped and outside any bag. |
| Anything else | A generic adapter: an item with `system.quantity` keeps its count, and anything else arrives as separate copies. This hasn't been tested against any particular system. |

None of these has been tried in a live Foundry world yet. See Testing below.

## Updates

Foundry can update a module only from a web address it can check. Crate Pop is set up for GitHub releases:

1. Make a GitHub repository called `crate-pop` and upload this folder's contents to it, including the hidden `.github` folder.
2. In `module.json`, replace `YOUR-GITHUB-NAME` with your GitHub username in the three links.
3. To release a version, publish a GitHub release tagged like `v1.0.1`. The included workflow writes that version into `module.json`, builds `crate-pop.zip`, and attaches both to the release.
4. Install it in Foundry with **Install Module** and this manifest link: `https://github.com/YOUR-GITHUB-NAME/crate-pop/releases/latest/download/module.json`. From then on, Foundry's **Check for Updates** finds new releases.

Until you do that, the links point nowhere, so Foundry just reports no update.

## Testing

What was tested, outside Foundry:

- **The hand-over, for each system:** for Mothership, Call of Cthulhu, Daggerheart, D&D 5e and the generic adapter, the real hand-over code ran against mock crates and characters that follow each system's item rules. The rules came from the systems' published source code. Each item moved from the crate to the sheet with its full count. Stacks merged where the system stacks them, and nothing was left behind.
- **No duplication or loss:** three players grabbing the same last item at once, 40 times per system, always gave exactly one winner. 200 random simultaneous grabs per system never created or destroyed an item. A sheet that refuses an item gets it put back in the crate.
- **Permissions:** players can't loot into someone else's sheet, a locked crate or a hidden one. They also can't add or remove items.
- **The Foundry wiring:** a mock of Foundry's 13/14 interface checked the double-click patch, the GM request routing, drag-and-drop onto both kinds of sheet, the sidebar, the token menu and toolbar buttons, and the window itself.

The tests are in the `tests` folder. If you have Node.js, run `node tests/core.test.mjs` and `node tests/glue.test.mjs mosh` from the module folder. You can swap `mosh` for `CoC7`, `daggerheart` or `dnd5e`. Foundry ignores this folder.

What wasn't tested: it hasn't run in a real Foundry world, in any system. The code follows Foundry 14's published API documentation, and Mothership, Call of Cthulhu and Daggerheart each list Foundry 14 as verified in their own manifests. Try it on a test scene before a session.

## Limitations

- Players can only take items. They can't put them back in.
- Money that a system keeps as a number on the sheet, not as an item, can't go in a crate.
- A D&D 5e bag goes in on its own. Its contents don't come with it.
- If two GMs are logged in, Foundry picks one to handle requests. Changing GM mid-grab is untested.
- Foundry can't prove which player sent a request. A player who types code into the browser console could pretend to be someone else. That's true of every Foundry module that talks to the GM.
- The window takes its colours, fonts and buttons from Foundry's theme and your system's stylesheet. How native it looks depends on the system.
