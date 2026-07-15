// Live-feed client for feed detail pages. Kept tiny and framework-free, and
// loaded on every page (the shell includes it) so it works however you arrive at a
// detail page — a full load or an htmx <main> swap whose snippet carries no script.
//
// It drives four things:
//   * <img data-refresh="URL">   — a JPEG snapshot cam: swap src with a cache-buster
//                                   every REFRESH_MS so the still keeps updating.
//   * <img data-mjpeg src="URL"> — a multipart MJPEG stream: plays natively, so we only
//                                   attach an error handler that falls back to the still.
//   * <video data-hls="URL">     — an HLS stream: play natively (Safari) or via
//                                   hls.js, which is fetched on demand the first time
//                                   an HLS cam is actually viewed (never on other pages).
//   * <a class="yt-facade" data-yt="ID"> — a YouTube stream: on click, swap in a
//                                   youtube-nocookie iframe (no third-party DOM until then).
// MP4 cams need no JS (<video src> autoplays). Any failure adds .feed-error to the
// element; the "View live"/"Watch on YouTube" link is always present as the fallback.

(function () {
	"use strict";

	var REFRESH_MS = 5000;
	var HLS_SRC = "/hls.min.js";

	// ── hls.js on-demand loader ────────────────────────────────────────────────
	var hlsState = "idle"; // idle | loading | ready | failed
	var hlsWaiters = [];

	function ensureHls(cb) {
		if (hlsState === "ready" || typeof window.Hls !== "undefined") return cb(true);
		if (hlsState === "failed") return cb(false);
		hlsWaiters.push(cb);
		if (hlsState === "loading") return;
		hlsState = "loading";
		var s = document.createElement("script");
		s.src = HLS_SRC;
		s.onload = function () {
			hlsState = "ready";
			flush(true);
		};
		s.onerror = function () {
			hlsState = "failed";
			flush(false);
		};
		document.head.appendChild(s);
	}

	function flush(ok) {
		var waiters = hlsWaiters;
		hlsWaiters = [];
		for (var i = 0; i < waiters.length; i++) waiters[i](ok);
	}

	// ── Auto-refreshing JPEG ───────────────────────────────────────────────────
	function startImg(img) {
		if (img.__liveInit) return;
		img.__liveInit = true;
		var base = img.getAttribute("data-refresh");
		if (!base) return;
		var fallback = img.getAttribute("src") || ""; // the baked same-origin still
		var sep = base.indexOf("?") === -1 ? "?" : "&";
		var stop = function () {
			if (img.__liveTimer) {
				clearInterval(img.__liveTimer);
				img.__liveTimer = null;
			}
		};
		// A cross-origin live feed can be hotlink-blocked or dead: stop hammering it and
		// fall back to the baked still (the "View live" link remains the escape hatch).
		img.addEventListener("error", function () {
			img.classList.add("feed-error");
			stop();
			if (fallback && img.src !== fallback) img.src = fallback;
		});
		var tick = function () {
			img.src = base + sep + "_=" + Date.now();
		};
		tick(); // go live immediately (the initial src is the baked same-origin still)
		img.__liveTimer = setInterval(tick, REFRESH_MS);
	}

	// ── MJPEG <img> (multipart stream) ─────────────────────────────────────────
	// A multipart/x-mixed-replace <img> plays live with no JS; we only attach an error
	// handler so a blocked (mixed-content) or dead stream falls back to the baked still
	// instead of a broken-image icon. No timer, so nothing to tear down.
	function startMjpeg(img) {
		if (img.__liveInit) return;
		img.__liveInit = true;
		var still = img.getAttribute("data-still") || "";
		img.addEventListener("error", function () {
			img.classList.add("feed-error");
			if (still && img.getAttribute("src") !== still) img.setAttribute("src", still);
		});
	}

	// ── HLS <video> ────────────────────────────────────────────────────────────
	function startHls(video) {
		if (video.__liveInit) return;
		video.__liveInit = true;
		var url = video.getAttribute("data-hls");
		if (!url) return;
		var fail = function () {
			video.classList.add("feed-error");
		};
		// Native HLS (Safari / iOS): no library needed.
		if (video.canPlayType("application/vnd.apple.mpegurl")) {
			video.src = url;
			video.addEventListener("error", fail);
			return;
		}
		ensureHls(function (ok) {
			if (!ok || typeof window.Hls === "undefined" || !window.Hls.isSupported()) return fail();
			var hls = new window.Hls({ liveDurationInfinity: true });
			video.__liveHls = hls;
			hls.on(window.Hls.Events.ERROR, function (_e, data) {
				if (data && data.fatal) {
					try {
						hls.destroy();
					} catch (x) {}
					fail();
				}
			});
			hls.loadSource(url);
			hls.attachMedia(video);
		});
	}

	// ── Click-to-load YouTube facade (streams detail pages) ─────────────────────
	// The facade is an <a class="yt-facade" data-yt="<id>" href="<watch url>">. Swap it
	// for a youtube-nocookie iframe on click, in place — no third-party DOM loads until
	// the user opts in. Delegated on document so it survives htmx <main> swaps with no
	// per-element init; without JS the <a> just opens the video on YouTube.
	function loadYt(facade) {
		var id = facade.getAttribute("data-yt");
		if (!id) return;
		var iframe = document.createElement("iframe");
		iframe.className = "yt-embed";
		iframe.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(id) + "?autoplay=1&rel=0";
		iframe.title = facade.getAttribute("aria-label") || "YouTube video";
		iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
		iframe.setAttribute("allowfullscreen", "");
		facade.replaceWith(iframe);
	}

	document.addEventListener("click", function (e) {
		var facade = e.target && e.target.closest ? e.target.closest(".yt-facade") : null;
		if (facade) {
			e.preventDefault();
			loadYt(facade);
		}
	});

	// ── Lifecycle ──────────────────────────────────────────────────────────────
	// Bootstrap + htmx-swap re-init/teardown live in live-lifecycle.js; this script
	// supplies only init/teardown. init always runs against document (register calls
	// init(document)), so it can query directly; collect() handles the removed nodes.
	var collect = window.liveLifecycle.collect;

	function init(root) {
		root = root || document;
		var imgs = root.querySelectorAll("img[data-refresh]");
		for (var i = 0; i < imgs.length; i++) startImg(imgs[i]);
		var mjpegs = root.querySelectorAll("img[data-mjpeg]");
		for (var m = 0; m < mjpegs.length; m++) startMjpeg(mjpegs[m]);
		var vids = root.querySelectorAll("video[data-hls]");
		for (var j = 0; j < vids.length; j++) startHls(vids[j]);
	}

	// Stop timers / tear down hls for content that was swapped out, so navigating
	// between detail pages doesn't leak intervals or keep streams buffering.
	function teardown(root) {
		var imgs = collect(root, "img[data-refresh]");
		for (var i = 0; i < imgs.length; i++) if (imgs[i].__liveTimer) clearInterval(imgs[i].__liveTimer);
		var vids = collect(root, "video[data-hls]");
		for (var j = 0; j < vids.length; j++)
			if (vids[j].__liveHls)
				try {
					vids[j].__liveHls.destroy();
				} catch (x) {}
	}

	window.liveLifecycle.register({ init: init, teardown: teardown });
})();
