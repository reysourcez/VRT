/* ============================================================
   Site Navigation Config — single source of truth
   ------------------------------------------------------------
   The "Business Analysis" dropdown used to be a hand-written
   <li> list, duplicated identically in every page's <nav> — adding
   one new tool meant editing every existing HTML file (or asking
   whichever AI session owned each one to do it). This file is the
   fix: the list of pages lives here, ONCE, and every page that
   loads this script renders its own dropdown from it.

   TO ADD A NEW PAGE: add one line to RZ_NAV_PAGES below. Nothing
   else on any page needs to change — no HTML edits, no asking an
   AI to touch a page it doesn't own. See SITE_CONFIG_STANDARD.md
   for the one-time retrofit a page needs before it picks this up.

   aria-current="page" is worked out here too, from the browser's
   own URL — one less thing to remember to move by hand when a page
   is added, renamed, or reordered (see the 2026-09-08 and
   2026-09-17 change-note entries on other pages for how easy this
   was to get out of sync doing it manually).
   ============================================================ */

const RZ_NAV_PAGES = [
  { href: 'menu-calculator.html', label: 'Menu Calculator' },
  { href: 'overhead-manpower-calculator.html', label: 'Overhead &amp; Manpower' },
  { href: 'printing-calculator.html', label: 'Printing Calculator' },
  { href: 'interactive-costing-analysis.html', label: 'Costing Analysis' },
  { href: 'margin-audit-calculator.html', label: 'Margin Analysis' },
  { href: 'food-worth-calculator.html', label: 'Food Worth' },
  { href: 'crypto-radar.html', label: 'Crypto Radar' },
  { href: 'rental-calculator.html', label: 'Rental Calculator' },
  { href: 'market-radar.html', label: 'Market Radar' },
  { href: 'cost-structure-checker.html', label: 'Cost Structure Checker' },
  { href: 'qr-listing-creator.html', label: 'QR Listing Creator' },
  { href: 'sop-creator.html', label: 'SOP Creator' },
  { href: 'project-plan-architect.html', label: 'Project Planner' },
  { href: 'form-scanner.html', label: 'Form Creator' },
  { href: 'qr-creator.html', label: 'QR Creator' },
  { href: 'Reysourcez-Transcriber-page_v0.2.html', label: 'Voice Transcriber' },
  // Add a new tool here — one line, this file only.
];

function rzCurrentPageFile() {
  const path = window.location.pathname.split('/').pop();
  return path || 'index.html';
}

// Renders every .nav-dropdown-menu found on the page (there's
// normally exactly one) from RZ_NAV_PAGES above. Deliberately
// doesn't touch the footer's own "Site" link list — that block is
// display:none site-wide today (see styles.css section 11), so
// wiring it up would be work spent on something nobody can see;
// flagged in SITE_CONFIG_STANDARD.md instead of guessed at here.
function rzRenderNavDropdown() {
  const current = rzCurrentPageFile();
  const html = RZ_NAV_PAGES.map((p) => {
    const currentAttr = p.href === current ? ' aria-current="page"' : '';
    return `<li><a href="${p.href}"${currentAttr}>${p.label}</a></li>`;
  }).join('');
  document.querySelectorAll('.nav-dropdown-menu').forEach((ul) => { ul.innerHTML = html; });
}

document.addEventListener('DOMContentLoaded', rzRenderNavDropdown);
