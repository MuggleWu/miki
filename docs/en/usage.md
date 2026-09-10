# User Guide

English | [简体中文](../zh/usage.md)

Five views: **Decks** (home) → Study → Browser → Stats → Settings. Single-key shortcuts `S` `B` `T` `D` jump directly; `D` returns home.

Launching: the packaged app lives at `/Applications/Miki.app` (type `miki` in Raycast, or launch from Spotlight/Dock; single instance — launching again just focuses the existing window). For development use `npm run dev`.

## Decks (Home)

- "Create deck" adds a new one; the two lines below the page show today's reviews / lifetime review count, plus shortcut hints (chips style).
- Table columns: deck name / total / new / due; sorted by name (number-aware, `1 xxx` before `2 xxx`). Due = learning/review cards that are due right now (excludes new, not-yet-due and suspended cards); the total includes suspended cards.
- The "…" menu at the end of each row: **Rename** / **Delete**. Deleting a deck keeps its cards in the data files, but they disappear from every view; deck deletion is irreversible.

## Study

- `Space` reveals the answer; after revealing, `Space` or `3` rates Good, `1` Again, `2` Hard, `4` Easy.
- Each rating button shows a live preview of the next due date it would produce (previews ignore interval fuzzing for stable display).
- Queue order: learning queue (minute-level steps, slots back in when due) → cards due today → new cards. As long as any review card due today is unfinished (including ones due later today), no new cards are dealt — finish the old, then the new. Learning comebacks slot back in when due without blocking new cards. Daily reviews are unlimited.
- Add/edit happens in a standalone child window: drag it out of the main window (including onto another screen); its position and size are remembered across launches. Front/back Markdown inputs grow with content (no fixed-height inner scrolling); when content overflows, the window itself scrolls vertically. Select text and press `⌘B` (Windows `Ctrl+B`) to toggle bold (with no selection, inserts `****`); `⌘Z` undoes. In add mode the form stays open after submitting, so you can keep adding cards.
- Backtick `` ` `` (front/back inputs in the add/edit window and the browser editor panel): single press with no selection inserts a pair (cursor centered), with a selection wraps inline code; three consecutive presses produce a fenced code block (with a selection, wraps it with ``` lines above and below; without, creates an empty block with the cursor on the content line). Detection is text-pattern based with no key-interval limit: after two presses the text looks like `` ``|`` ``, and the third press converts automatically.
- List continuation: pressing Enter at the end of a list line inserts the same-level marker automatically (ordered lists increment, indentation is kept); Enter on an empty list item exits the list. Works in both the add/edit window and the browser editor panel.
- `A` adds a card, `E` edits the current card, `⌘D` deletes the current card (soft delete), `⌘Z` undoes the last answer or deletion (multi-step).
- Card faces support Markdown, KaTeX math and syntax highlighting; typeface and size are adjustable in Settings.
- A card whose cumulative Again count reaches the leech threshold is auto-suspended (⏸) and leaves the queue; unsuspend it in the Browser.

## Browser

- Left panel: deck tree ("All decks" = every non-deleted deck); the search box at the top accepts multiple space-separated keywords (AND, matching front/back, case-insensitive); `⌘F` focuses it.
- **Columns**: click a header to sort (click again to flip; multi-level sorts follow click order), right-click a header to choose visible columns; drag a header's right edge to resize. All three widths (left panel / table / right panel) are draggable and remembered across launches.
- **Selection**: click a row to select it (the right panel loads front/back; edits auto-save after 800ms); `⌘`-click toggles multi-select, `Shift`-click selects a range, `⌘A` selects all in the current view.
- **Row context menu**: change deck (scheduling progress is kept) / reset progress (back to new, irreversible) / delete (soft, undoable) — with multi-select these apply to the whole group and the menu shows the count.
- **Filters**: two dropdowns in the toolbar — "state" filters by scheduling state (new / learning / review / suspended, where suspended is the leech pool), and "due" filters by due window (due / due today / overdue / next 3 days / next 7 days / next 30 days / scheduled). Both combine with the search terms and the deck selection, the choices are remembered across launches, and "clear filters" resets them in one click.
  "Overdue" and "due today" are strictly complementary (overdue = due before 00:00 today), so nothing is double-counted or missed. Every due option except "any" only shows cards that have a scheduled due date; new cards have none and therefore do not appear (use the state filter for those).
- The "due in" column refreshes every 60 seconds; the selection is restored across launches.
- Pagination: 400 rows per page, with the next page prefetched as you scroll near the bottom (the whole library is never fetched at once, so even very large decks keep scrolling). Timed refreshes re-fetch only the loaded prefix to preserve scroll position; changing the search or filter terms returns to the first page.

## Stats

- Six panels: forecast / review heatmap / reviews / **retention** / card states / interval distribution.
- The dropdown at the top filters by deck; the time range toggles between "last year / all".
- The forecast is 38 equal-width time bars: "last year" splits the next 365 days into 38 buckets; "all" splits the span from the furthest due date to the earliest overdue card (overdue backlog lands on the far left). Hover to see each bucket's range and count.
- Retention: the share of answered reviews in range that were rated anything but Again (undos already netted out; the deck and range dropdowns apply here too), plus the average answer time per card. The dashed line on the chart is the desired retention from Settings.
  The two measure different things — desired retention is the probability of recall *when a card comes due*, counting only due review cards, while this panel's denominator includes new and learning cards. What is comparable is each one's **trend**, not the two numbers themselves.

## Settings

- Workspace (user profile): each workspace folder is one complete profile (decks, cards, review history and config are all independent). Switch or remove entries from the list; "Add workspace…" picks any folder (created if missing); switching restarts the app. The window title shows "Miki - <workspace name>" (e.g. Miki - miki-base). On first launch, before any workspace exists, an onboarding screen asks you to pick a folder.
- Study fonts: typeface + size with a live sample; defaults follow the system font at 16px.
- Leech threshold: how many cumulative Again ratings trigger auto-suspension; `0` disables it.
- Window size/position/maximized state are remembered across launches: adjustments are saved into the workspace `config.json` automatically, and the next launch restores the most recent size (clamped back into a visible screen if, say, an external display was unplugged).
- Theme toggling lives on the ☀️ / 🌙 buttons in the top bar (light is the default), not in Settings.

## Shortcut reference

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Reveal answer / rate Good | `Space` | `Space` |
| Rate Again / Hard / Good / Easy | `1` `2` `3` `4` | `1` `2` `3` `4` |
| Study (**home tab only**) / Browser / Stats / Home | `S` `B` `T` `D` | `S` `B` `T` `D` |
| Add card / Edit current card | `A` `E` | `A` `E` |
| Delete current card | `⌘D` | `Ctrl+D` |
| Undo last answer / delete | `⌘Z` | `Ctrl+Z` |
| Select all (Browser) | `⌘A` | `Ctrl+A` |
| Focus browser search | `⌘F` | `Ctrl+F` |
| Bold selection in editor | `⌘B` | `Ctrl+B` |
| Toggle source / preview in editor | `` ` `` | `` ` `` |
| Confirm add/edit window | `⌘Enter` | `Ctrl+Enter` |
| Close add/edit window | `Esc` | `Esc` |

Single-key shortcuts are ignored while typing in a text field, so `Ctrl+C/V` etc. keep working inside inputs.

## Data & backup

- All data lives in the workspace folder, separate from the code; the actual path is whichever folder you picked in first-launch onboarding (the prompt suggests `~/miki-base`), and `MIKI_WORKSPACE` can override it. See [data-format.md](data-format.md) for the format.
- Backing up = copying the folder; managing review history with git also works (NDJSON split by month, append-friendly).
- **Hot reload**: external changes to the workspace while the app is running (e.g. `git pull` syncing new content) are detected and applied automatically, no restart or window switching needed; the card being studied is not cleared (same card keeps its question/answer phase).
- For programmatic access (scripts / AI), use the local HTTP API or MCP — see [api.md](api.md).
