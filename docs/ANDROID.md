# Android: what would it take?

Status: **desk research, nothing run on a phone.** It answers the questions in the roadmap issue (#14) from Mozilla's documentation and from this repository's code. No Android device was connected when it was written, so every "should work" below is untested.

## Short answer

Firefox for Android runs WebExtensions, and the extension already declares it (`gecko_android` in the manifest, minimum Firefox 142). But the extension would **not work on a phone as it is**, mainly because the approval prompt cannot open. It fails *closed* (the action is refused), never open. A working spike needs one real change (a different approval surface) and a device to test on.

## What Mozilla documents ([differences between desktop and Android extensions](https://extensionworkshop.com/documentation/develop/differences-between-desktop-and-android-extensions/))

* Android offers a **subset** of the WebExtensions APIs. Not available: `bookmarks`, `history`, `sessions` and **`windows`** (there is a single browser window).
* A `browserAction`/`action` **popup opens as an overlay** that covers the browser until the person closes it, not as a floating window.
* The `devtools.*` APIs (`inspectedWindow`, `network`, `panels`) are not available; Firefox for Android is inspected by remote debugging over USB or Wi-Fi.
* Permissions are granted automatically; the person is not asked.
* Developing: enable USB debugging, turn on "Remote debugging via USB" in Firefox, check the phone with `adb devices`, and use `web-ext run --target=firefox-android` or `about:debugging`.

## What this means for BrowserForge

| Part | Uses | On Android |
|---|---|---|
| Link to the local program | `new WebSocket('ws://127.0.0.1:<port>/ext')` from the background script | The phone's `127.0.0.1` is the phone. The daemon runs on a computer, so it must be reached by reversing the port: `adb reverse tcp:7345 tcp:7345` (standard `adb`; it maps the phone's port to the computer's). Untested whether Firefox lets the extension open that socket. |
| Approval prompt | `api.windows.create({ type: 'popup' })` (`openApprovalWindow` in `background.ts`) | **`windows` does not exist.** The call throws and is caught, so no prompt opens and the approval **times out as denied**. Safe, but every consequential action is refused. |
| Agent window | `api.windows.create/update/remove/get` | Not available. The agent would have to work in the tab you already have open. |
| Toolbar popup | `action.default_popup` (`popup.html`) | Exists, as an overlay, but an extension cannot open it without a tap, so it cannot be the thing that interrupts an agent mid-task. |
| Tabs, scripting, storage, alarms, content script | `tabs.*`, `scripting.executeScript`, `storage.local`, `alarms` | Documented as supported; untested here. |
| Network capture | `webRequest` (no `debugger`, which is Chrome-only) | `webRequest` is not in the unsupported list; behaviour on Android untested. |

## What would have to change

1. **An approval surface that exists on Android.** The safest option is to open `approve.html` as a **tab** (`tabs.create`) and bring it to the front, then close it after the answer. The rule that the agent cannot answer for you must still hold: the prompt page talks only to the background script, and no tool can press its buttons. This needs a design review on its own, because a tab can be navigated away from.
2. **Feature detection instead of assuming `windows`.** `api.windows` is `undefined` on Android; every use needs a guard, and the agent-window feature should report "not available on this browser" instead of failing.
3. **A reachable daemon.** `adb reverse` for a spike; for real use the daemon would have to listen on the local network with TLS, which the current security model (loopback only, `docs/SECURITY.md`) deliberately avoids. That is a larger decision than the extension changes.
4. **A phone-sized layout** for the popup and approval page (`popup.css` is written for a desktop popup).

## Suggested spike (needs a phone)

1. Install Firefox for Android (Nightly or release 142+), enable remote debugging.
2. `adb reverse tcp:7345 tcp:7345`, start `browserforge serve` on the computer.
3. `npx web-ext run --target=firefox-android --android-device <serial> -s apps/firefox-extension/dist/firefox`, paste the extension token.
4. Check, in order: does it connect; does `browser_navigate` and `browser_get_interactive_elements` work; what happens on a click that needs approval (expect: refused after the timeout); then try the tab-based approval page.
5. Write what happened here and in the issue.

Until step 4 has been done on a real device, treat Android as **not supported**.
