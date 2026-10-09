# Third-party notices

Note Ink is derived from Mobile Ink Annotation by peyote / jepicaju862-lab:
https://github.com/jepicaju862-lab/mobile-ink-annotation
Licensed under GPL-3.0-or-later; the original LICENSE is retained.

The distributed main.js bundles pdf-lib 1.17.1 (MIT), @pdf-lib/standard-fonts (MIT),
@pdf-lib/upng (MIT), pako (MIT/Zlib), and tslib (0BSD).
Their copyright and license texts are preserved in the generated bundle's legal comments
and in THIRD_PARTY_LICENSES.txt. Obsidian itself supplies its API and PDF.js renderer. PDF.js 5.4.624 CMaps
(Apache-2.0 / Adobe license), Foxit standard fonts and Liberation fonts are
bundled as offline fallback assets; their license texts are included in main.js
and THIRD_PARTY_LICENSES.txt.

Development-only dependencies (Obsidian type declarations, esbuild, TypeScript,
Playwright and the PDF.js parser used by tests) are not included in the runtime package.
