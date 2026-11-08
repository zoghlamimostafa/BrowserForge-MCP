# Safari: feasibility

Status: **desk research from Apple's documentation, nothing built or run.** There is no Mac in the project's test setup, and Safari runs only on Apple systems, so none of this has been tried. It answers the roadmap issue (#13).

## Short answer

Probably possible, but it is a separate product with a real cost: a Mac, Xcode, an Apple Developer Program membership, and an App Store review. The unknown that decides it is whether Safari lets the extension keep a WebSocket open to `127.0.0.1`. That has to be tested on a Mac before anything else.

## What Apple documents

* Safari runs WebExtensions. An existing Chrome/Firefox extension is converted with `xcrun safari-web-extension-converter <extension folder>` (see Apple's [guide to converting existing web extensions](https://developer.apple.com/news/?id=qiz0arxc) and [Meet Safari Web Extensions](https://developer.apple.com/videos/play/wwdc2020/10665/)). The tool needs Xcode and warns about manifest keys the installed Safari does not support.
* Xcode produces a **container app** that holds the extension. Safari extensions are distributed through the App Store inside that app, and distribution needs **Apple Developer Program membership** ([Safari Extensions](https://developer.apple.com/safari/extensions/)).
* An extension can declare a background page and content scripts, like other browsers.

## What this means for BrowserForge

| Part | Used by BrowserForge | Question for Safari |
|---|---|---|
| Link to the local program | `WebSocket` to `ws://127.0.0.1:<port>/ext` from the background script | **Not answered by the sources I found.** Does Safari allow it from an extension page? Does it need an extra permission or a changed CSP? Does a background page that Safari suspends drop the socket? |
| Manifest | MV3, `background.scripts`, `webRequest`, `<all_urls>`, a content script with `world: "MAIN"` | The converter will say which keys it rejects; `webRequest` support is the one to check, because response capture depends on it. |
| Approval prompt | `windows.create({ type: 'popup' })` | Whether `windows` is available the way it is in Chrome/Firefox is unchecked. |
| Capture of bodies | Chrome: `debugger`. Firefox: opt-in `webRequest.filterResponseData` | Safari has no `debugger`; whether it has a body filter is **unchecked**. Expect metadata only until proven otherwise. |
| Tests | Playwright WebKit exists here, but it is **not Safari with extensions** | Real Safari on a Mac is needed; CI would need a macOS runner and signing. |

## Costs and risks

* **Money and accounts:** the Apple Developer Program is a paid yearly membership tied to a person or company; App Store review adds days and can reject an extension that automates other sites. Read the review guidelines before paying.
* **Review risk:** an extension whose purpose is "let an AI control your browser" may be treated differently from an ordinary one. Unknown until submitted.
* **Maintenance:** a third build target (Chrome, Firefox, Safari) means every change in the extension has to be checked in Safari too.

## Suggested next step (needs a Mac)

1. `xcrun safari-web-extension-converter apps/firefox-extension/dist/chrome` and read every warning.
2. Run the container app, enable the extension in Safari, start `browserforge serve`, paste the token.
3. Check, in order: does the WebSocket connect; does `browser_navigate` work; does the approval prompt open; does the connection survive Safari suspending the background page.
4. Record the result in the issue. If step 3 fails on the WebSocket, stop: the rest does not matter.

Until then, treat Safari as **not supported**.
