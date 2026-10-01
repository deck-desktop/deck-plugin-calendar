# Calendar

Your Google Calendar as a week grid, in a modal over whatever you were doing, with a reminder
before each meeting.

There is no tab. The grid is something you glance at and dismiss, so it opens from the footer
readout or the command palette and closes again. What stays on screen is the next meeting and
its Join button, which is the part you act on.

## The account is Deck's, not the plugin's

Deck owns the Google connection and hands this plugin a short-lived access token. The refresh
token - long-lived access to a whole Google account - never reaches a plugin bundle. The scope
requested is `calendar.readonly`, so this cannot create, move or delete anything.

Cached event details are stored under the `plugin-` config prefix, which keeps them on this
machine rather than syncing them to a phone and a server. Disconnecting the account clears them.

## What it exports

| Export | Where it renders |
|---|---|
| `Provider` | wraps the app, so the reminder loop runs whatever tab is open |
| `Status` | the footer readout: the next meeting, and a Join button |
| `commands` | palette entry to open the grid |

## Checks

```sh
node plugins/calendar/events.check.mjs
```

## Build

```sh
node plugins/calendar/build.mjs
```

See [../README.md](../README.md) for how the build and the shims work.

## Install

Copy `plugin.json` and `plugin.js` into `%APPDATA%\Deck\plugins\calendar\` (`Deck-Dev` for a
debug build) and restart Deck.
