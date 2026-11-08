# Dashboard

A page that shows what your BrowserForge has installed and what it is doing (it only reads, with one exception: you can switch a plugin on or off, and only after you approve it in the browser extension): connected browsers, MCP sessions and tools, plugins (with the permissions you approved), skills, recorded flows and the local models.

```bash
browserforge serve          # in one terminal
browserforge dashboard      # opens http://127.0.0.1:7345/dashboard in your browser
browserforge dashboard --print   # only print the address
```

On Windows, use the *BrowserForge dashboard* entry in the Start menu.

| Tab | Shows |
|---|---|
| **Overview** | Server version and uptime, connected browsers (and which extension version), open MCP sessions, how many tools, plugins, skills and flows there are |
| **MCP** | How to connect an agent, and every tool grouped by area (`browser`, `network`, `api`, ...) or by plugin, filterable, with read-only tools marked |
| **Plugins** | Each plugin loaded, skipped (and why) or switched off, with what it may do in plain words and the tools it adds, and a **Switch on / Switch off** button |
| **Skills** | Each skill, what it needs, and its ready-made workflows with their inputs |
| **Flows** | The 20 newest recorded flows: site, steps, parameters, how many steps need approval, outcome, replays |
| **Local models** | Whether Qwen (Ollama) and Laya (Ollaya) are reachable, and the scorecard of who decided how many steps and how often those runs were good or bad |

It refreshes every 5 seconds. Apart from the plugin switch below, it changes nothing: each page shows the terminal command for the change you may want (`browserforge plugin remove <id>`, `browserforge flow export ...`).

## Switching a plugin on or off

The **Plugins** tab has a **Switch off** / **Switch on** button for each plugin. It never changes anything by itself:

1. You press the button. The page asks the server.
2. The server asks **you, in the BrowserForge browser extension** (the approval window or the popup), saying which plugin and, for switching on, what it was allowed to do when you installed it. The page waits and says so.
3. Only if you approve there is the plugin list changed. A denial, a timeout, no browser connected, YOLO mode on, or a second request while one is waiting changes nothing (the page tells you which).
4. The running server keeps its current tools until you **restart** it. The card shows "off after restart" or "on after restart" until then, and you can press the button again to undo it.

What it cannot do: install a plugin, remove one, or give a plugin more than you approved at install (if a plugin later asks for more, it stays off). While **YOLO mode** is on in the extension (it approves everything by itself) the switch refuses and asks nothing, because a permission change has to be a person's answer: switch YOLO off in the popup first, or use the terminal. It also refuses when what the plugin may do is too long to show in the approval prompt, so nobody approves what they cannot read.

## How it stays safe

* The page and its two files carry no data. The data comes from `/dashboard/data`, which needs the **dashboard token**: a third secret, `dashboard-token` in your settings folder, separate from the MCP token and the extension token. The MCP token does not open the dashboard, and the dashboard token opens nothing else.
* `browserforge dashboard` puts the token in the address after a `#`. A browser never sends that part to a server; the page keeps it for that tab only and removes it from the address bar.
* Only the page itself may call the data address: a request from any other website is refused, as is any request whose `Host` is not the loopback address (DNS rebinding).
* A strict Content-Security-Policy allows nothing but the page's own two files, and it cannot be put in a frame. Text that comes from plugins, skills or flows is shown as plain text, never as HTML.
* The switch is the only route that can change anything (`POST /dashboard/plugins/<id>/enable|disable`). It needs the dashboard token **and** an `Origin` that is exactly the page's own address, so another website or a plain script cannot call it, and then it still waits for your approval in the extension. The MCP token cannot reach it, so an agent cannot use it to change its own tools.
* It never shows tokens, secrets, typed values, page content or your profile.

Tests: [tests/integration/dashboard.test.ts](../tests/integration/dashboard.test.ts), [tests/security/dashboard.test.ts](../tests/security/dashboard.test.ts).

## Next

Not done yet: installing or removing a plugin from the page, and switching skills on or off. Both stay in the terminal for now. The roadmap is on the [project board](https://github.com/users/zoghlamimostafa/projects/1).
