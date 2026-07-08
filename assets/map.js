// Pan/zoom client for the SVG world map. Kept tiny and framework-free, and loaded
// on every page (the shell includes it) so it works however you arrive at the map,
// including an htmx <main> swap whose snippet carries no script. It no-ops on every
// page that has no map.
//
// The map itself (worldmap.ts outlines + a dot per camera) is a plain inert SVG that
// works with no JS: a fixed world view whose dots are real links with native <title>
// hover tooltips. This script only *enhances* it: drag to pan, wheel to zoom, by
// nudging the SVG viewBox (no tiles, no fetch). A drag is prevented from triggering a
// dot's link so panning never navigates by accident.

(function () {
	"use strict";

	var MAX_ZOOM = 12; // deepest zoom-in relative to the full-world view
	var DRAG_PX = 3; // screen px of movement before a gesture counts as a drag, not a click

	function parseVB(svg) {
		var a = (svg.getAttribute("viewBox") || "").split(/[ ,]+/).map(Number);
		if (a.length !== 4 || a.some(isNaN)) return null;
		return { x: a[0], y: a[1], w: a[2], h: a[3] };
	}

	function startMap(svg) {
		if (svg.__mapInit) return;
		var base = parseVB(svg);
		if (!base) return;
		svg.__mapInit = true;

		var vb = { x: base.x, y: base.y, w: base.w, h: base.h };
		var aspect = base.h / base.w;
		var ctrl = new AbortController();
		svg.__mapAbort = ctrl;
		var sig = { signal: ctrl.signal };

		var apply = function () {
			svg.setAttribute("viewBox", vb.x + " " + vb.y + " " + vb.w + " " + vb.h);
		};
		var clamp = function () {
			vb.w = Math.min(base.w, Math.max(base.w / MAX_ZOOM, vb.w));
			vb.h = vb.w * aspect;
			vb.x = Math.min(base.x + base.w - vb.w, Math.max(base.x, vb.x));
			vb.y = Math.min(base.y + base.h - vb.h, Math.max(base.y, vb.y));
		};

		// Wheel: zoom toward the cursor, keeping the point under it fixed. Normalize
		// wheel units (line/page vs pixel) and clamp per-event, so a mouse notch and a
		// trackpad flick both zoom gently instead of jumping.
		svg.addEventListener(
			"wheel",
			function (e) {
				e.preventDefault();
				var m = svg.getScreenCTM();
				if (!m) return;
				var ux = (e.clientX - m.e) / m.a;
				var uy = (e.clientY - m.f) / m.d;
				var fx = (ux - vb.x) / vb.w;
				var fy = (uy - vb.y) / vb.h;
				var d = e.deltaY;
				if (e.deltaMode === 1) d *= 16; // lines -> ~px
				else if (e.deltaMode === 2) d *= 100; // pages -> ~px
				d = Math.max(-60, Math.min(60, d)); // damp big flicks
				vb.w *= Math.exp(d * 0.0016); // ~10% per notch at most; d>0 zooms out
				vb.h = vb.w * aspect;
				vb.x = ux - fx * vb.w;
				vb.y = uy - fy * vb.h;
				clamp();
				apply();
			},
			{ passive: false, signal: ctrl.signal },
		);

		// Pointer drag: pan. Scale stays fixed mid-drag, so the screen->user scale
		// captured at pointerdown (m.a / m.d) stays valid for the whole gesture.
		var dragging = false;
		var moved = false;
		var sx = 0;
		var sy = 0;
		var ox = 0;
		var oy = 0;
		var scaleX = 1;
		var scaleY = 1;

		svg.addEventListener(
			"pointerdown",
			function (e) {
				var m = svg.getScreenCTM();
				if (!m) return;
				dragging = true;
				moved = false;
				sx = e.clientX;
				sy = e.clientY;
				ox = vb.x;
				oy = vb.y;
				scaleX = m.a;
				scaleY = m.d;
				svg.setPointerCapture(e.pointerId);
			},
			sig,
		);
		svg.addEventListener(
			"pointermove",
			function (e) {
				if (!dragging) return;
				var dx = e.clientX - sx;
				var dy = e.clientY - sy;
				if (Math.abs(dx) + Math.abs(dy) > DRAG_PX) moved = true;
				vb.x = ox - dx / scaleX;
				vb.y = oy - dy / scaleY;
				clamp();
				apply();
			},
			sig,
		);
		var endDrag = function (e) {
			if (!dragging) return;
			dragging = false;
			try {
				svg.releasePointerCapture(e.pointerId);
			} catch (x) {}
		};
		svg.addEventListener("pointerup", endDrag, sig);
		svg.addEventListener("pointercancel", endDrag, sig);

		// A drag that ends over a dot must not follow its link. Swallow the click that
		// the browser fires after a moving pointerup, before it reaches the <a>/htmx.
		svg.addEventListener(
			"click",
			function (e) {
				if (moved) {
					e.preventDefault();
					e.stopPropagation();
					moved = false;
				}
			},
			{ capture: true, signal: ctrl.signal },
		);
	}

	function stopMap(svg) {
		if (svg.__mapAbort) {
			try {
				svg.__mapAbort.abort();
			} catch (x) {}
			svg.__mapAbort = null;
		}
		svg.__mapInit = false;
	}

	function collect(root, sel) {
		if (!root || root.nodeType !== 1) return [];
		var list = root.querySelectorAll ? Array.prototype.slice.call(root.querySelectorAll(sel)) : [];
		if (root.matches && root.matches(sel)) list.push(root);
		return list;
	}

	function init(root) {
		root = root || document;
		// querySelectorAll directly (document is nodeType 9, which collect() rejects);
		// collect() is only for the MutationObserver's added/removed element nodes.
		var maps = root.querySelectorAll ? Array.prototype.slice.call(root.querySelectorAll("svg.worldmap")) : collect(root, "svg.worldmap");
		for (var i = 0; i < maps.length; i++) startMap(maps[i]);
	}
	function teardown(root) {
		var maps = collect(root, "svg.worldmap");
		for (var i = 0; i < maps.length; i++) stopMap(maps[i]);
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", function () {
			init(document);
		});
	} else {
		init(document);
	}

	// htmx swaps <main> for SPA-like navigation. Mirror traffic.js: watch the DOM and
	// (re-)init a map in newly inserted content, tearing down a removed one so its
	// listeners don't leak between page swaps.
	if (typeof MutationObserver !== "undefined" && document.body) {
		var pending = false;
		var mo = new MutationObserver(function (muts) {
			var added = false;
			for (var i = 0; i < muts.length; i++) {
				var m = muts[i];
				for (var rIdx = 0; rIdx < m.removedNodes.length; rIdx++) teardown(m.removedNodes[rIdx]);
				if (m.addedNodes.length) added = true;
			}
			if (added && !pending) {
				pending = true;
				setTimeout(function () {
					pending = false;
					init(document);
				}, 0);
			}
		});
		mo.observe(document.body, { childList: true, subtree: true });
	}
})();
