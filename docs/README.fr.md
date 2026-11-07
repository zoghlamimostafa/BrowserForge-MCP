<div align="center">

[English](../README.md) · **Français** · [العربية](README.ar.md)

<img src="assets/browserforge-overview.svg" alt="BrowserForge MCP : les agents IA parlent MCP à un démon local, qui pilote votre vrai Firefox ou Chrome grâce à une extension, avec l'accord d'un humain pour les actions importantes" width="100%">

# BrowserForge MCP

**Donnez à votre agent IA un vrai navigateur, et transformez le trafic qu'il observe en documentation d'API et en clients.**

Une extension Firefox + Chrome et un serveur MCP, qui fonctionnent en local, pour Claude Code, OpenAI Codex et tout autre client MCP.

### Installer l'extension

<a href="https://chromewebstore.google.com/detail/browserforge/ihbkpcclcolaeppmfgmndmemjljmiaec"><img alt="Ajouter BrowserForge à Chrome (Chrome Web Store)" src="https://img.shields.io/chrome-web-store/v/ihbkpcclcolaeppmfgmndmemjljmiaec?logo=googlechrome&logoColor=white&label=Add%20to%20Chrome&style=for-the-badge&color=4285F4" height="56"></a>&nbsp;&nbsp;
<a href="https://addons.mozilla.org/en-US/firefox/addon/browserforge/"><img alt="Ajouter BrowserForge à Firefox (Firefox Add-ons)" src="https://img.shields.io/amo/v/browserforge?logo=firefoxbrowser&logoColor=white&label=Add%20to%20Firefox&style=for-the-badge&color=FF7139" height="56"></a>&nbsp;&nbsp;
<a href="https://github.com/zoghlamimostafa/BrowserForge-MCP/releases/latest"><img alt="Télécharger l'installateur Windows" src="https://img.shields.io/badge/Windows-installer%20(.exe)-0078D6?logo=windows&logoColor=white&style=for-the-badge" height="56"></a>

Chrome, Edge et Brave utilisent la version du Chrome Web Store. Installez ensuite le petit programme local : sous **Windows**, lancez l'installateur ci-dessus (il apporte son propre Node.js ; Windows peut afficher un avertissement parce que l'installateur n'est pas encore signé : *Informations complémentaires*, puis *Exécuter quand même*) ; sur les autres systèmes, voyez le [Démarrage rapide](#démarrage-rapide).

[![npm](https://img.shields.io/npm/v/@el-makina-ai/browserforge-mcp?logo=npm&label=npm&color=CB3837)](https://www.npmjs.com/package/@el-makina-ai/browserforge-mcp)
[![CI](https://github.com/zoghlamimostafa/BrowserForge-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/zoghlamimostafa/BrowserForge-MCP/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/zoghlamimostafa/BrowserForge-MCP?label=release)](https://github.com/zoghlamimostafa/BrowserForge-MCP/releases/latest)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Node >= 20](https://img.shields.io/badge/node-%E2%89%A5%2020-339933)
![MCP](https://img.shields.io/badge/protocol-MCP-black)

</div>

---

> Cette page est la traduction française du début du [README](../README.md) (le reste n'est pas traduit). Elle n'a pas encore été relue par une personne dont le français est la langue maternelle : les corrections sont les bienvenues, par issue ou par pull request. En cas de doute, le texte anglais fait foi.

## L'idée

Les agents IA savent bien décider quoi faire sur un site web, mais on ne peut pas leur confier ses comptes les yeux fermés. BrowserForge comble cet écart : l'agent travaille dans **votre vrai navigateur** grâce à une extension, un petit **programme local** transmet ses requêtes, et **c'est vous qui approuvez** tout ce qui a des conséquences (envoyer, publier, payer, mots de passe, fichiers joints) par un clic auquel l'agent ne peut pas répondre à votre place. Ce que l'agent voit et apprend reste sur votre ordinateur et devient des éléments réutilisables : des **flux** rejouables, des **compétences** (*skills*) partageables, et des **spécifications d'API et des clients** construits à partir du trafic observé. Pour l'histoire complète, la différence avec l'automatisation sans interface et les autres passerelles de navigateur, et la direction du projet : **[VISION.md](VISION.md)** (en anglais).

## Pourquoi BrowserForge

| | |
|---|---|
| **Vrai navigateur, vraie session** | Une WebExtension, pas un clone sans interface : vos onglets, vos connexions, vos cookies. |
| **Local d'abord** | Tout tourne sur `127.0.0.1`. Pas de service dans le cloud, pas de crédits d'API. |
| **Rétro-ingénierie d'API** | Capturez le trafic, puis obtenez les points d'accès, les schémas, l'authentification et la pagination, une spécification OpenAPI 3.1 et des clients Python / TypeScript / JavaScript / PHP. |
| **Un humain dans la boucle** | L'envoi de formulaires, les achats, l'envoi de messages, l'acceptation de conditions, les mots de passe et les fichiers joints attendent un clic dans la fenêtre de l'extension, auquel l'agent ne peut pas répondre. Un bouton rouge **STOP** arrête l'agent jusqu'à ce que vous le relanciez. |
| **Des résultats honnêtes** | Chaque fait déduit sur une API est étiqueté `observed` (observé), `inferred` (déduit) ou `hypothesis` (hypothèse), avec un niveau de confiance et des preuves. Les limites de capture de chaque navigateur sont décrites dans [LIMITATIONS.md](LIMITATIONS.md) (en anglais). |
| **Sûr par défaut** | Transports locaux protégés par jeton, vérification des en-têtes Origin et Host, schémas stricts, secrets masqués, accès aux fichiers limité à des chemins sûrs. Voir [SECURITY.md](SECURITY.md) (en anglais). |

## Démarrage rapide

Nécessite Node.js 22 ou plus récent, et Chrome, Edge, Brave ou Firefox, sous Linux, macOS ou Windows (Linux est le système sur lequel il a été testé ; voir [INSTALL.md](INSTALL.md)).

```bash
# From npm (no build): npm install -g @el-makina-ai/browserforge-mcp   then:   browserforge setup
# From a checkout:
npm install && npm run build
node apps/mcp-server/dist/cli.js serve     # prints endpoints, creates tokens in ~/.config/browserforge/
node apps/mcp-server/dist/cli.js tokens    # shows the extension token
```

1. **Installez l'extension** depuis la boutique :
   - [Chrome Web Store](https://chromewebstore.google.com/detail/browserforge/ihbkpcclcolaeppmfgmndmemjljmiaec) (Chrome, Edge, Brave)
   - [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/browserforge/)

   Vous travaillez depuis une copie du dépôt ? Chargez plutôt votre propre version compilée :
   - Firefox : `about:debugging#/runtime/this-firefox` → *Charger un module complémentaire temporaire* → `apps/firefox-extension/dist/firefox/manifest.json`
   - Chrome : `chrome://extensions` → Mode développeur → *Charger l'extension non empaquetée* → `apps/firefox-extension/dist/chrome`
2. **Connectez-la.** Cliquez sur l'icône dans la barre d'outils, collez le **jeton de l'extension**, puis appuyez sur *Connect*.
3. **Connectez votre agent.** Guides : [Codex](CODEX.md) · [Claude Code](CLAUDE_CODE.md)
   ```bash
   codex mcp add browserforge --url http://127.0.0.1:7345/mcp --bearer-token-env-var BROWSERFORGE_MCP_TOKEN
   claude mcp add --transport http browserforge http://127.0.0.1:7345/mcp --header "Authorization: Bearer $(cat ~/.config/browserforge/mcp-token)"
   ```
4. **Essayez.** Lancez le site de démonstration avec `node tests/fixtures/demo-site/server.mjs`, puis demandez à votre agent :

   > Call `system_status`, then open `http://127.0.0.1:8099/apply` and describe the form.

   (En français : « Appelle `system_status`, puis ouvre `http://127.0.0.1:8099/apply` et décris le formulaire. »)

Instructions complètes : [INSTALL.md](INSTALL.md) · guides dans le [wiki](https://github.com/zoghlamimostafa/BrowserForge-MCP/wiki) · ce qui est prévu : le [tableau de route](https://github.com/users/zoghlamimostafa/projects/1). En cas de problème : [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
