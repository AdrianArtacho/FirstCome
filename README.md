# FirstCome

A small GitHub Pages app for shared, first-come-first-served lists. Each row in a public Google Sheet becomes a numbered option. Clicking it reserves it for that visitor, then opens its destination. Everyone else sees **Taken**.

**[Open FirstCome](https://adrianartacho.github.io/FirstCome/)** · **[Preview the interface](https://adrianartacho.github.io/FirstCome/?demo=1)**

**The hosted app is connected to its shared reservation service.** Paste your public two-column Google Sheet URL into the home page to create a sharing link. No student account or login is needed. GitHub Pages serves the interface; Google stores the shared claims.

The interface preview is temporary and browser-local. The setup below is for hosting your own separate installation; it is already complete for the linked FirstCome app.

A [live example list](https://adrianartacho.github.io/FirstCome/?sheet=https%3A%2F%2Fdocs.google.com%2Fspreadsheets%2Fd%2F1xnNqk3oLOkGE6bD6KrWUtc9MgYPnMLMlLNIbDS6WTk8%2Fedit%3Fgid%3D941701021&title=FirstCome+example) and its [two-column source sheet](https://docs.google.com/spreadsheets/d/1xnNqk3oLOkGE6bD6KrWUtc9MgYPnMLMlLNIbDS6WTk8/edit#gid=941701021) are available. Unlike the interface preview, choices in this example are real shared claims.

Deployment verified on 25 November 2026: two independent tabs claimed the same option concurrently; exactly one received the destination, and the other received Taken. Reloading preserved the claim. Reloading during a second reservation recovered the same claim without an extra receipt. The 20 automated checks also pass.

## Your spreadsheet

Use an ordinary Google Sheet with two columns, optionally headed `Text` and `URL`:

| Text | URL |
| --- | --- |
| Bach — The Art of Fugue | https://en.wikipedia.org/wiki/The_Art_of_Fugue |
| Beethoven — Grosse Fuge | https://en.wikipedia.org/wiki/Grosse_Fuge |

An [example CSV](examples/options.csv) is included. Put complete links in column B, rather than link text or a hyperlink formula. Blank rows are ignored. Each label + URL pair must be unique; different labels may point to the same URL. There can be up to 250 options.

Set **Share → General access → Anyone with the link → Viewer**. Select the tab containing the options and copy the browser address, including its `gid` tab ID. Use the normal `https://docs.google.com/spreadsheets/d/…/edit#gid=…` link. “Publish to the web” `/d/e/` links are not supported. A link with no `gid` uses tab ID `0`.

## Setup

This is a one-time setup. The same service can handle multiple public sheets.

1. Visit [Google Apps Script](https://script.google.com/home) and create a **New project**, named **FirstCome**.
2. Replace the contents of `Code.gs` with [backend/Code.gs](backend/Code.gs) and save.
3. Select `setup` in the function selector and click **Run**. Authorize the script in your account. It creates **FirstCome — private claims**, a separate spreadsheet for the reservations. Keep this spreadsheet private. Your two-column source sheets are never modified.
4. Choose **Deploy → New deployment → Web app**. Set **Execute as: Me** and **Who has access: Anyone**. Deploy and copy the **Web app URL** ending in `/exec`. If your organisation does not offer “Anyone”, use a Google account whose administrator permits anonymous web apps.
5. In this repository, open **Settings → Pages**. Choose **Deploy from a branch → main → /(root)** and save, if Pages is not already enabled.
6. Open [FirstCome](https://adrianartacho.github.io/FirstCome/), paste your public Sheet URL and Apps Script web-app URL, and click **Create sharing link**. Share the resulting link with everyone.

For a simpler URL containing only the sheet parameter, paste your `/exec` URL into `DEFAULT_API_URL` in [config.js](config.js) and commit it once. The endpoint URL is public configuration, not a password. Everyone using a particular list must use the same Apps Script project; a separate project creates a separate claim pool.

The optional [Apps Script manifest](backend/appsscript.json) records the scopes explicitly. Pasting only `Code.gs` is sufficient; Apps Script can detect the required permissions. To update an existing deployment after editing the script, choose **Deploy → Manage deployments → Edit → New version → Deploy**, preserving its `/exec` URL.

## Sharing links

The home page builds correctly encoded links for you:

```text
https://adrianartacho.github.io/FirstCome/?sheet=ENCODED_SHEET_URL
```

| Parameter | Purpose |
| --- | --- |
| `sheet` | URL-encoded normal Google Sheets URL; includes the tab's `gid`. |
| `api` | URL-encoded deployed Apps Script `/exec` URL; optional when configured in `config.js`. |
| `title` | Optional heading, such as “Choose a presentation topic”. |
| `demo=1` | Temporary interface preview, without a shared backend. |

Do not paste an unencoded Sheet URL containing `&` or `#` into another URL. Use the sharing-link form or `URLSearchParams`.

## How claiming works

- Only the server can grant an option. It locks the claim store, checks availability, rereads the public source, records the winner, and flushes the write before unlocking. Simultaneous clicks yield one winning receipt. “First” means the first request to obtain the server lock, not necessarily the earliest physical click on devices with different network delays.
- The page opens the destination only after verifying a successful server receipt. A failed or lost network response never counts as success. **Check my choice** safely retries the same receipt; it cannot reserve an option twice.
- The list refreshes every 20 seconds while visible, and when returning to the tab. A stale list can show an option briefly, but the server rejects its second claim.
- Claimed options remain numbered and disabled. This keeps the list stable and shows what has been taken.
- Receipts are remembered in the current tab when browser storage is available, allowing the winner to reopen their link after returning. Storage is only for recovery; the authoritative claim lives on Google. If the tab or its receipt is lost, the claim remains taken.
- Claims are scoped to spreadsheet ID + tab ID. Reordering rows preserves claims. **Changing an option's label or URL creates a new option.** Avoid editing these while a list is active. Removing and later restoring the exact same pair restores its old claimed state.

## Starting again

For a fresh class or round, duplicate the source sheet's tab (giving it a new `gid`) or duplicate the spreadsheet, then create a new sharing link. Keep the same Apps Script endpoint. Existing lists retain their claims. There is deliberately no public reset button.

## Boundaries and privacy

This is an anonymous allocation tool for a trusted group, not protected access to the destination. The source sheet and its links are public; a person can copy a destination directly. The app guarantees at most one successful claim per option, but does not limit each person to one option or prevent automated claiming. No names or email addresses are collected.

Source sheets are fetched anonymously, without the organiser's credentials. A supplied Sheet URL cannot expose another private sheet from their account. The claim spreadsheet stays private, stores hashed receipt tokens, and is never included in the source sheet. JSONP is read-only and runs in a sandboxed iframe, so a supplied service endpoint cannot read other lists' receipts from the Pages origin. Share only links using a backend you trust.

Designed for classroom-sized lists. It uses Apps Script quotas, reads a maximum 500 KB source, and retains up to 20,000 receipt rows. It is not intended for ticket-sale traffic. Do not delete old claim rows to make space while their lists are still active: doing so can reopen those options. Retire the old lists first, retain a private archive, and use a new service project for new lists if necessary.

## Development and checks

No frontend build or dependencies are required. Serve the repository with a static HTTP server, e.g. `python3 -m http.server 8000`, and open `http://localhost:8000/?demo=1`.

```sh
npm test
```

The Node tests exercise backend behavior with mocked Apps Script services and test the browser client's receipt logic. They do not replace a real deployment check. After deployment, open the same test-list link in two separate browsers, choose the same option, and verify that only one browser opens its destination. Repeat with a connection interruption and **Check my choice**.

References: [Apps Script web apps](https://developers.google.com/apps-script/guides/web), [locking and flush](https://developers.google.com/apps-script/reference/lock/lock), [ContentService and JSONP](https://developers.google.com/apps-script/guides/content), [quotas](https://developers.google.com/apps-script/guides/services/quotas).
