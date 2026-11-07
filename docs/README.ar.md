<div align="center">

[English](../README.md) · [Français](README.fr.md) · **العربية**

<img src="assets/browserforge-overview.svg" alt="BrowserForge MCP: وكلاء الذكاء الاصطناعي يتحدثون بروتوكول MCP مع برنامج محلي، والبرنامج يتحكم في متصفح Firefox أو Chrome الحقيقي عبر إضافة، مع موافقة بشرية على الإجراءات المهمة" width="100%">

# BrowserForge MCP

</div>

<div dir="rtl">

**امنح وكيل الذكاء الاصطناعي متصفحًا حقيقيًا، وحوّل حركة الشبكة التي يراها إلى توثيق لواجهات API وإلى عملاء جاهزين.**

إضافة لمتصفحي Firefox وChrome وخادم MCP يعملان محليًا على جهازك، لاستخدامهما مع Claude Code وOpenAI Codex وأي عميل MCP آخر.

</div>

<div align="center">

### تثبيت الإضافة

<a href="https://chromewebstore.google.com/detail/browserforge/ihbkpcclcolaeppmfgmndmemjljmiaec"><img alt="أضف BrowserForge إلى Chrome (متجر Chrome الإلكتروني)" src="https://img.shields.io/chrome-web-store/v/ihbkpcclcolaeppmfgmndmemjljmiaec?logo=googlechrome&logoColor=white&label=Add%20to%20Chrome&style=for-the-badge&color=4285F4" height="56"></a>&nbsp;&nbsp;
<a href="https://addons.mozilla.org/en-US/firefox/addon/browserforge/"><img alt="أضف BrowserForge إلى Firefox (إضافات Firefox)" src="https://img.shields.io/amo/v/browserforge?logo=firefoxbrowser&logoColor=white&label=Add%20to%20Firefox&style=for-the-badge&color=FF7139" height="56"></a>&nbsp;&nbsp;
<a href="https://github.com/zoghlamimostafa/BrowserForge-MCP/releases/latest"><img alt="تنزيل مثبّت Windows" src="https://img.shields.io/badge/Windows-installer%20(.exe)-0078D6?logo=windows&logoColor=white&style=for-the-badge" height="56"></a>

</div>

<div dir="rtl">

متصفحات Chrome وEdge وBrave تستخدم النسخة الموجودة في متجر Chrome الإلكتروني. بعد ذلك ثبّت البرنامج المحلي الصغير: على **Windows** شغّل المثبّت أعلاه (يأتي ومعه Node.js الخاص به؛ وقد يعرض Windows تحذيرًا لأن المثبّت غير موقّع رقميًا بعد: اختر *مزيد من المعلومات* ثم *تشغيل على أي حال*)، وعلى الأنظمة الأخرى انظر [البدء السريع](#البدء-السريع).

</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@el-makina-ai/browserforge-mcp?logo=npm&label=npm&color=CB3837)](https://www.npmjs.com/package/@el-makina-ai/browserforge-mcp)
[![CI](https://github.com/zoghlamimostafa/BrowserForge-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/zoghlamimostafa/BrowserForge-MCP/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/zoghlamimostafa/BrowserForge-MCP?label=release)](https://github.com/zoghlamimostafa/BrowserForge-MCP/releases/latest)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Node >= 20](https://img.shields.io/badge/node-%E2%89%A5%2020-339933)
![MCP](https://img.shields.io/badge/protocol-MCP-black)

</div>

---

<div dir="rtl">

> هذه الصفحة ترجمة عربية للجزء الأول من [README](../README.md) فقط (بقية الملف غير مترجمة). لم يراجعها بعد شخص لغته الأم العربية، فالتصحيحات مرحَّب بها عبر issue أو pull request. وعند أي اختلاف يُعتمد النص الإنجليزي.

## الفكرة

وكلاء الذكاء الاصطناعي بارعون في تحديد ما يجب فعله على موقع ويب، لكن لا يصح أن نسلّمهم حساباتنا دون رقابة. يسدّ BrowserForge هذه الفجوة: يعمل الوكيل في **متصفحك الحقيقي** عبر إضافة، ويحمل **برنامج محلي** صغير طلباته، و**أنت من يوافق** على كل ما له عواقب (الإرسال، النشر، الدفع، كلمات المرور، رفع الملفات) بنقرة لا يستطيع الوكيل أن يجيب عنها بدلًا منك. وما يراه الوكيل ويتعلمه يبقى على حاسوبك ويتحول إلى أشياء قابلة لإعادة الاستخدام: **تدفقات** (flows) يمكن إعادة تشغيلها، و**مهارات** (skills) يمكن مشاركتها، و**مواصفات API وعملاء** مبنيون على الحركة التي لوحظت. للقصة الكاملة، وللفرق بين هذا المشروع والأتمتة بلا واجهة وجسور المتصفح الأخرى، ولاتجاه المشروع: **[VISION.md](VISION.md)** (بالإنجليزية).

## لماذا BrowserForge

| | |
|---|---|
| **متصفح حقيقي وجلسة حقيقية** | إضافة WebExtension وليست نسخة بلا واجهة: علامات تبويبك، وتسجيلات دخولك، وملفات تعريف الارتباط (cookies) الخاصة بك. |
| **محلي أولًا** | كل شيء يعمل على `127.0.0.1`. لا خدمة سحابية ولا رصيد API. |
| **هندسة عكسية لواجهات API** | التقط حركة الشبكة ثم احصل على نقاط النهاية والمخططات والمصادقة والترقيم، ومواصفة OpenAPI 3.1، وعملاء بلغات Python وTypeScript وJavaScript وPHP. |
| **إنسان في الحلقة** | إرسال النماذج، والمشتريات، وإرسال الرسائل، وقبول الشروط، وكلمات المرور، ورفع الملفات تنتظر نقرة في نافذة الإضافة لا يستطيع الوكيل الإجابة عنها. وزر **STOP** الأحمر يوقف الوكيل حتى تستأنفه. |
| **نتائج صادقة** | كل معلومة مستنتجة عن واجهة API موسومة بـ `observed` (مُلاحَظة) أو `inferred` (مستنتَجة) أو `hypothesis` (فرضية)، مع درجة ثقة ودليل. وقيود الالتقاط لكل متصفح موثقة في [LIMITATIONS.md](LIMITATIONS.md) (بالإنجليزية). |
| **آمن افتراضيًا** | قنوات محلية محمية برمز (token)، وفحص لترويستَي Origin وHost، ومخططات صارمة، وإخفاء للأسرار، ووصول إلى الملفات عبر مسارات آمنة فقط. انظر [SECURITY.md](SECURITY.md) (بالإنجليزية). |

## البدء السريع

يتطلب Node.js 22 أو أحدث، ومتصفح Chrome أو Edge أو Brave أو Firefox، على Linux أو macOS أو Windows (Linux هو النظام الذي جُرّب عليه المشروع؛ انظر [INSTALL.md](INSTALL.md)).

</div>

```bash
# From npm (no build): npm install -g @el-makina-ai/browserforge-mcp   then:   browserforge setup
# From a checkout:
npm install && npm run build
node apps/mcp-server/dist/cli.js serve     # prints endpoints, creates tokens in ~/.config/browserforge/
node apps/mcp-server/dist/cli.js tokens    # shows the extension token
```

<div dir="rtl">

1. **ثبّت الإضافة** من المتجر:
   - [متجر Chrome الإلكتروني](https://chromewebstore.google.com/detail/browserforge/ihbkpcclcolaeppmfgmndmemjljmiaec) (Chrome وEdge وBrave)
   - [إضافات Firefox](https://addons.mozilla.org/en-US/firefox/addon/browserforge/)

   تعمل من نسخة المستودع؟ حمّل النسخة التي بنيتَها بنفسك:
   - Firefox: `about:debugging#/runtime/this-firefox` ← *Load Temporary Add-on* ← `apps/firefox-extension/dist/firefox/manifest.json`
   - Chrome: `chrome://extensions` ← وضع المطوّر ← *Load unpacked* ← `apps/firefox-extension/dist/chrome`
2. **اربطها.** انقر أيقونة الإضافة في شريط الأدوات، والصق **رمز الإضافة** (extension token)، ثم اضغط *Connect*.
3. **اربط وكيلك.** الأدلة: [Codex](CODEX.md) · [Claude Code](CLAUDE_CODE.md)

</div>

```bash
codex mcp add browserforge --url http://127.0.0.1:7345/mcp --bearer-token-env-var BROWSERFORGE_MCP_TOKEN
claude mcp add --transport http browserforge http://127.0.0.1:7345/mcp --header "Authorization: Bearer $(cat ~/.config/browserforge/mcp-token)"
```

<div dir="rtl">

4. **جرّبه.** شغّل موقع العرض التجريبي بالأمر `node tests/fixtures/demo-site/server.mjs`، ثم اطلب من وكيلك:

   > Call `system_status`, then open `http://127.0.0.1:8099/apply` and describe the form.

   (بالعربية: «استدعِ `system_status`، ثم افتح `http://127.0.0.1:8099/apply` وصِف النموذج.»)

التعليمات الكاملة: [INSTALL.md](INSTALL.md) · الأدلة في [الويكي](https://github.com/zoghlamimostafa/BrowserForge-MCP/wiki) · المخطط له: [لوحة خارطة الطريق](https://github.com/users/zoghlamimostafa/projects/1). عند حدوث مشكلة: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

</div>
