// Manual theme picker. Progressive-enhancement only: the selector is written into the
// DOM by this script, so non-JS visitors never see it and the site keeps following the
// OS `prefers-color-scheme` preference untouched.
//
// The active theme is a class on <html> (document.documentElement), not <body>: the
// inline restore script in the shell's <head> re-applies the saved class before first
// paint (no flash of the OS theme), and <head> runs before <body> exists. CSS keys off
// :root.light / :root.dark / :root.cctv to override the media-query default.
//
// htmx swaps only <main>'s innerHTML, so <html> and the injected header <aside> both
// survive navigation with no re-init — a plain one-shot IIFE is enough, no lifecycle
// registration like feeds.js / map.js need.

(function () {
	"use strict";

	// Selectable theme classes. Order is irrelevant; kept in sync with the <option>
	// values below and the :root.<class> blocks in style.css.
	var THEMES = ["dark", "light", "cctv"];

	// The picker markup. Mirrors the shell's own hand-built HTML: an <aside> the header
	// CSS already right-aligns (body > header aside), holding a labelled <select>.
	var MARKUP =
		'<select id="themeSel" aria-label="Select Theme">' +
			'<option value="">Theme</option>' +
			"<hr />" +
			'<optgroup label="Style:">' +
				'<option value="dark">Dark</option>' +
				'<option value="light">Light</option>' +
				'<option value="cctv">CCTV</option>' +
			"</optgroup>" +
		"</select>";

	// ── CRT overlay (cctv theme) ──────────────────────────────────────────────────────
	// The effect is a fixed, click-through viewport overlay: scanlines / sweep (wrapper
	// pseudo-elements) plus curvature / noise / vignette (sibling divs), all absolutely
	// positioned and pointer-events:none per crt.css. Because it never wraps page content,
	// it can't clip scrolling and htmx <main> swaps don't touch it. window.__CRT is the
	// build-time-precomputed spec baked into /crt-config.js. The green phosphor palette
	// itself comes from :root.cctv in style.css; this only adds the glass/scanline layers.
	var CRT_ID = "crt-overlay";

	function mountCrt() {
		if (document.getElementById(CRT_ID)) return;
		var spec = window.__CRT;
		if (!spec || !spec.wrapper) return;
		var w = document.createElement("div");
		w.id = CRT_ID;
		w.className = spec.wrapper.className;
		// Apply only the precomputed custom properties (the effect knobs). The fixed,
		// click-through layout + z-index live in the #crt-overlay rule in style.css; the
		// library's own content-sizing layout props (position/width/height) are skipped.
		var s = spec.wrapper.style || {};
		for (var k in s) {
			if (Object.prototype.hasOwnProperty.call(s, k) && k.charAt(0) === "-") {
				w.style.setProperty(k, String(s[k]));
			}
		}
		var layers = spec.overlays || [];
		for (var i = 0; i < layers.length; i++) {
			var o = document.createElement("div");
			o.className = layers[i];
			w.appendChild(o);
		}
		document.body.appendChild(w);
	}

	function unmountCrt() {
		var el = document.getElementById(CRT_ID);
		if (el) el.remove();
	}

	// Which theme class (if any) is currently on <html>.
	function current() {
		var cl = document.documentElement.classList;
		for (var i = 0; i < THEMES.length; i++) {
			if (cl.contains(THEMES[i])) return THEMES[i];
		}
		return "";
	}

	function apply(v) {
		var cl = document.documentElement.classList;
		cl.remove.apply(cl, THEMES);
		if (v) {
			cl.add(v);
			try { localStorage.setItem("theme", v); } catch (e) {}
		} else {
			try { localStorage.removeItem("theme"); } catch (e) {}
		}
		if (v === "cctv") mountCrt();
		else unmountCrt();
	}

	function init() {
		var header = document.querySelector("body > header");
		if (!header || document.getElementById("theme")) return;

		var aside = document.createElement("aside");
		aside.id = "theme";
		aside.innerHTML = MARKUP;
		header.appendChild(aside);

		var sel = aside.querySelector("#themeSel");
		// Reflect the class the head script already applied so the control opens on the
		// active theme (empty "Theme" == Auto / follow the OS preference).
		sel.value = current();
		// The head script may have already applied cctv before paint; mount its overlay now.
		if (current() === "cctv") mountCrt();
		sel.addEventListener("change", function () {
			apply(sel.value);
		});
	}

	// Deferred script at the end of <body>: the header already exists, so run now.
	// Guard on readyState anyway in case load order ever changes.
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();
