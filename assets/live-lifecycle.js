// Shared htmx-swap lifecycle for the client enhancement scripts (feeds.js, map.js).
// Both need the same wiring: run an init pass on first load, and on every htmx <main>
// swap re-init newly inserted content while tearing down what was removed. This owns
// that plumbing (a DOMContentLoaded bootstrap + a MutationObserver on <body>), so each
// script only supplies its own init(root) / teardown(root). Loaded (deferred) before
// feeds.js and map.js, so window.liveLifecycle exists when they register.

(function () {
	"use strict";

	/** Matching elements within `root`, plus `root` itself if it matches. */
	function collect(root, sel) {
		if (!root || root.nodeType !== 1) return [];
		var list = root.querySelectorAll ? Array.prototype.slice.call(root.querySelectorAll(sel)) : [];
		if (root.matches && root.matches(sel)) list.push(root);
		return list;
	}

	// init(document) now (or on DOMContentLoaded), then on each htmx structural swap
	// teardown(removedNode) and re-init(document). A burst of mutations coalesces into
	// one init pass. Attribute changes (feeds.js's own src cache-busting) aren't observed,
	// so this only fires on real content swaps.
	function register(hooks) {
		var init = hooks.init;
		var teardown = hooks.teardown;

		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", function () {
				init(document);
			});
		} else {
			init(document);
		}

		if (typeof MutationObserver !== "undefined" && document.body) {
			var pending = false;
			var mo = new MutationObserver(function (muts) {
				var added = false;
				for (var i = 0; i < muts.length; i++) {
					var m = muts[i];
					for (var r = 0; r < m.removedNodes.length; r++) teardown(m.removedNodes[r]);
					if (m.addedNodes.length) added = true;
				}
				if (added && !pending) {
					pending = true; // coalesce a burst of mutations into one init pass
					setTimeout(function () {
						pending = false;
						init(document);
					}, 0);
				}
			});
			mo.observe(document.body, { childList: true, subtree: true });
		}
	}

	window.liveLifecycle = { collect: collect, register: register };
})();
