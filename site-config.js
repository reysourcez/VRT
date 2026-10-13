/* ============================================================
   Site Config — business numbers, in one place
   ------------------------------------------------------------
   NOT a replacement for a tool's own on-page inputs — Target Food
   Cost %, Cost Buffer %, per-dish prices and so on all stay exactly
   where they are, still editable per item in each tool's own UI.
   This is for the smaller set of values that are currently a plain
   JS constant sitting inside one tool's own .js file, edited by
   opening that file directly — sometimes duplicated byte-for-byte
   in more than one tool, which is its own risk (see guideRatios
   below for a real example already found on this site).

   A plain global .js file, not a .json fetched at runtime, on
   purpose: this site has no build step and some pages are still
   tested by opening the .html file directly (file://) rather than
   through a server — fetch() of a local file is blocked by the
   browser in that case (this is already documented as a known
   limitation of the tool-dock's own fetch() calls elsewhere on this
   site), but a plain <script src="site-config.js"> tag loads fine
   either way. Same reasoning as every other shared global here
   (RZ_TOOLS, RZ_PANEL_GROUPS, RZ_NAV_PAGES) — no new pattern
   introduced, just applied to business numbers instead of nav
   entries or tool URLs.

   HOW A TOOL READS THIS: guard with a typeof check and keep its own
   literal fallback, so a page that hasn't added the <script> tag
   yet keeps working exactly as before — nothing hard-depends on
   this file existing. See interactive-costing-analysis.js's
   GUIDE_RATIOS for the worked example, and
   SITE_CONFIG_STANDARD.md for the retrofit steps for every other
   page.

       const X = (typeof RZ_SITE_CONFIG !== 'undefined' && RZ_SITE_CONFIG.x) || { ...literal fallback... };

   TO CHANGE A VALUE: edit it below. Every tool that's been
   retrofitted to read from here picks it up the next time that
   page loads — no other file needs touching.
   ============================================================ */

const RZ_SITE_CONFIG = {

  // ---- Site identity ----
  // Not wired into anything visible yet — every page's own <title>,
  // .brand link, and footer text still has its own literal copy of
  // these strings, and the footer itself is display:none site-wide
  // today anyway (styles.css section 11), so there's nothing live
  // to dynamize right now. Defined here anyway, same "cheap now,
  // useful later" reasoning as costBufferPct in the Menu Calculator/
  // Costing Analysis sync payload — the moment a page's own script
  // wants to read a site name or contact address from one place
  // instead of hand-typing it again, it's already here.
  siteName: 'Reysourcez Enterprise',
  contactEmail: 'reysourcez.ent@gmail.com',
  tagline: 'We focus on providing catered solutions to your dilemmas.',

  // ---- Venue-type guide ratios ----
  // Ingredients/Overhead/Manpower/Margin benchmark split per venue
  // type, always summing to 100 — the "guide" pie Costing Analysis
  // and Margin Analysis both compare a vendor's own numbers against.
  // Found byte-for-byte identical in both tools' own files before
  // this change — meaning a future edit to just one of them (e.g.
  // "actually stores should guide at 33% ingredients, not 35%")
  // would have silently made the two tools disagree, the same shape
  // of bug the costBufferPct fix from 2026-09-19 closed for the
  // import/export path. This is that same fix applied to a config
  // value instead of a sync field.
  guideRatios: {
    home:  { ingredients: 55, overhead: 15, manpower: 15, margin: 15 },
    stall: { ingredients: 50, overhead: 20, manpower: 15, margin: 15 },
    truck: { ingredients: 42, overhead: 20, manpower: 23, margin: 15 },
    store: { ingredients: 35, overhead: 20, manpower: 30, margin: 15 },
  },

  // ---- Look and feel ----
  // Which named palette (see THEME_GUIDE.md) this deployment uses.
  // 'default' is the site's current teal look — every page already
  // renders this way with no other change needed. Not yet wired to
  // anything automatic (see THEME_GUIDE.md for why, and what a fully
  // automatic version would need); today this field is a label for
  // whichever [data-theme] block in styles.css a page opts into by
  // hand, and a landing spot for a future one-flip switch.
  theme: 'default',

  // ---- Voice Transcriber (added 2026-10-08, v0.2) ----
  // Read by Reysourcez-Transcriber-recorder_v0.2.js. Page behaviour only: the languages,
  // engines, caps and keys live in the Worker, never here. After deploying the Worker,
  // replace YOUR-SUBDOMAIN in apiBase with your own workers.dev address.
  transcriber: {
    version: '0.2',
    apiBase: 'https://reysourcez-transcriber-worker.YOUR-SUBDOMAIN.workers.dev',
    consentVersion: '2026-10-v1',   // must equal CONSENT_VERSION in the Worker
    segmentMinutes: 10,             // the recorder cuts a new part every N minutes
    maxUploadMB: 20,                // page-side check before an upload
    audioBitsPerSecond: 32000,      // voice quality; lower makes smaller files
    echoCancellation: false,        // off, so recording does not disturb a meeting app on the same computer
    noiseSuppression: false,
    autoGainControl: true,
    tabAudio: true,                 // offer "also record the meeting tab's sound" on desktop Chrome and Edge
    defaultLanguage: 'auto',
    defaultEngine: 'auto',
  },
};
