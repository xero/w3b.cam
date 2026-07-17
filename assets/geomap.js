// Fancy canvas world map for JS users, layered on top of the inert SVG (src/site/render/map.ts).
// The SVG stays the no-JS experience AND the fallback: this only upgrades to a canvas once
// d3 + topojson-client load from /d3.min.js and /topojson-client.min.js (fetched on demand,
// only here — like feeds.js does for hls.js). If any of that fails, the SVG and its plain
// viewBox pan/zoom (map.js) stay live, untouched.
//
// What the upgrade adds over the SVG: dots that stay a constant screen size, camera clustering
// that de-clusters as you zoom, and country -> state/province (admin-1) borders that lazy-load
// per country as you zoom in (/geo/world.json + /geo/admin1/<ADM0_A3>.json, baked by
// scripts/gen-geo.ts). Framework-free; registers init/teardown with window.liveLifecycle so it
// re-runs across htmx <main> swaps.

(function () {
	"use strict";

	var D3_SRC = "/d3.min.js";
	var TOPO_SRC = "/topojson-client.min.js";
	var WORLD_URL = "/geo/world.json";
	var ADMIN1_URL = function (a3) {
		return "/geo/admin1/" + a3 + ".json";
	};

	// Projection space the SVG dots were baked into (must match src/site/render/primitives.ts).
	var MAP_W = 1000;
	var MAP_H = 500;

	var MAX_K = 64; // deepest zoom
	var ADMIN1_K = 6; // zoom at which state borders load + draw
	var DOT_R = 2.3; // individual dot radius, screen px (constant — never balloons)
	var CLUSTER_PX = 44; // grid cell for clustering, screen px
	var HALO = 34; // off-screen cull padding, screen px
	var LIST_MAX = 300; // most cameras listed when a cluster can't be split by zoom

	// ── on-demand loader for d3 + topojson-client ───────────────────────────────
	var libState = "idle"; // idle | loading | ready | failed
	var libWaiters = [];

	function loadScript(src, cb) {
		var s = document.createElement("script");
		s.src = src;
		s.onload = function () {
			cb(true);
		};
		s.onerror = function () {
			cb(false);
		};
		document.head.appendChild(s);
	}

	function ensureLibs(cb) {
		if (libState === "ready" || (window.d3 && window.topojson)) return cb(true);
		if (libState === "failed") return cb(false);
		libWaiters.push(cb);
		if (libState === "loading") return;
		libState = "loading";
		// d3 first, then topojson (both tiny relative to the geo data); either failing bails.
		loadScript(D3_SRC, function (okD3) {
			if (!okD3) return finishLibs(false);
			loadScript(TOPO_SRC, function (okTopo) {
				finishLibs(okTopo);
			});
		});
	}

	function finishLibs(ok) {
		libState = ok ? "ready" : "failed";
		var w = libWaiters;
		libWaiters = [];
		for (var i = 0; i < w.length; i++) w[i](ok);
	}

	// ── theme colours (read from the CSS custom props, re-read when the theme changes) ──
	function readColors() {
		var cs = getComputedStyle(document.documentElement);
		var g = function (name, fallback) {
			var v = cs.getPropertyValue(name);
			return v && v.trim() ? v.trim() : fallback;
		};
		return {
			bg: g("--bg", "#0f1117"),
			land: g("--land", "#1b2333"),
			coast: g("--coast", "#2b3a52"),
			dot: g("--dot", "#5b8cff"),
			dotHi: g("--dot-hi", "#ffae57"),
			accent: g("--accent", "#6f9dff"),
			text: g("--text", "#e6e9ef"),
		};
	}

	function clamp(v, lo, hi) {
		return v < lo ? lo : v > hi ? hi : v;
	}

	// ── read the baked dots out of the SVG and un-project back to lng/lat ─────────
	function readPoints(svg) {
		var anchors = svg.querySelectorAll(".dots a");
		var pts = [];
		for (var i = 0; i < anchors.length; i++) {
			var a = anchors[i];
			var c = a.querySelector("circle");
			if (!c) continue;
			var cx = parseFloat(c.getAttribute("cx"));
			var cy = parseFloat(c.getAttribute("cy"));
			if (isNaN(cx) || isNaN(cy)) continue;
			var title = c.querySelector("title");
			pts.push({
				lng: (cx / MAP_W) * 360 - 180,
				lat: 90 - (cy / MAP_H) * 180,
				href: a.getAttribute("href") || "",
				snip: a.getAttribute("hx-get") || "",
				title: title ? title.textContent || "" : "",
				px: 0,
				py: 0,
			});
		}
		return pts;
	}

	// ── navigate exactly like clicking a real dot <a> (htmx body-swap + history) ──
	function navigate(p) {
		if (!p || !p.href) return;
		if (window.htmx && p.snip) {
			var a = document.createElement("a");
			a.setAttribute("href", p.href);
			a.setAttribute("hx-get", p.snip);
			a.setAttribute("hx-push-url", p.href);
			a.setAttribute("hx-target", "main");
			a.setAttribute("hx-swap", "innerHTML show:top");
			a.style.display = "none";
			document.body.appendChild(a);
			try {
				window.htmx.process(a);
				a.click();
			} catch (e) {
				window.location.href = p.href;
			}
			setTimeout(function () {
				a.remove();
			}, 0);
		} else {
			window.location.href = p.href;
		}
	}

	// ── build the canvas map for one <svg class="worldmap"> ──────────────────────
	function startCanvas(svg) {
		if (svg.__geoStarted) return;
		svg.__geoStarted = true;

		var pts = readPoints(svg);
		if (!pts.length) return; // empty map: nothing to upgrade

		ensureLibs(function (ok) {
			if (!ok || !svg.isConnected) return; // libs failed, or user already navigated away
			fetch(WORLD_URL)
				.then(function (r) {
					if (!r.ok) throw new Error("world " + r.status);
					return r.json();
				})
				.then(function (world) {
					if (svg.isConnected) build(svg, pts, world);
				})
				.catch(function () {
					/* leave the SVG + map.js fallback in place */
				});
		});
	}

	function build(svg, pts, world) {
		var d3 = window.d3;
		var topojson = window.topojson;
		var mapwrap = svg.parentNode;
		if (!mapwrap) return;

		var col = readColors();
		var canvas = document.createElement("canvas");
		canvas.className = "worldmap-canvas";
		canvas.setAttribute("role", "img");
		canvas.setAttribute("aria-label", svg.getAttribute("aria-label") || "Interactive map of geolocated cameras");
		mapwrap.insertBefore(canvas, svg);

		var ctx = canvas.getContext("2d");
		var projection = d3.geoEquirectangular();
		var path = d3.geoPath(projection, ctx);
		var pathBounds = d3.geoPath(projection); // no context: for feature bounds only

		// Base geography (drawn every frame under the zoom transform).
		var land = topojson.feature(world, world.objects.countries);
		var borders = topojson.mesh(world, world.objects.countries);

		// Per-country base-space bounds + admin-1 availability, for lazy state loading.
		var countryBoxes = []; // {a3, x0,y0,x1,y1}
		var admin1 = {}; // a3 -> {state: "loading"|"ready"|"failed", mesh, box, ctrl}

		var dpr = 1;
		var w = 0;
		var h = 0;
		var transform = d3.zoomIdentity;
		var clusters = [];
		var clustersK = -1;
		var visible = []; // rendered markers this frame: {sx,sy,r,cl}
		var hovered = null;
		var frame = 0;

		var zoom = d3
			.zoom()
			.scaleExtent([1, MAX_K])
			.on("zoom", function (e) {
				transform = e.transform;
				scheduleDraw();
			});

		function sizeToContainer() {
			var availW = mapwrap.clientWidth || svg.clientWidth || 1000;
			var maxH = Math.floor(window.innerHeight * 0.82);
			h = Math.min(Math.round(availW / 2), maxH); // world is 2:1
			w = Math.min(availW, h * 2);
			h = Math.round(w / 2);
			dpr = window.devicePixelRatio || 1;
			canvas.width = Math.round(w * dpr);
			canvas.height = Math.round(h * dpr);
			canvas.style.width = w + "px";
			canvas.style.height = h + "px";

			projection.fitSize([w, h], { type: "Sphere" });
			for (var i = 0; i < pts.length; i++) {
				var xy = projection([pts[i].lng, pts[i].lat]);
				pts[i].px = xy[0];
				pts[i].py = xy[1];
			}
			countryBoxes = [];
			var feats = land.features;
			for (var j = 0; j < feats.length; j++) {
				var f = feats[j];
				if (!f.properties || f.properties.a1 !== 1 || !f.id) continue;
				var b = pathBounds.bounds(f);
				countryBoxes.push({ a3: f.id, x0: b[0][0], y0: b[0][1], x1: b[1][0], y1: b[1][1] });
			}
			zoom.translateExtent([[0, 0], [w, h]]).extent([[0, 0], [w, h]]);
			clustersK = -1; // base coords moved: force a cluster rebuild
		}

		// Grid-cluster the points for the current zoom level k. Cells are a fixed screen size,
		// so they shrink (in base space) as you zoom → clusters split into individual dots.
		function rebuildClusters(k) {
			var cell = CLUSTER_PX / k;
			var cells = {};
			for (var i = 0; i < pts.length; i++) {
				var p = pts[i];
				var key = Math.floor(p.px / cell) + "_" + Math.floor(p.py / cell);
				var b = cells[key];
				if (!b) {
					b = cells[key] = { sx: 0, sy: 0, members: [] };
				}
				b.sx += p.px;
				b.sy += p.py;
				b.members.push(p);
			}
			var out = [];
			for (var key2 in cells) {
				var c = cells[key2];
				var n = c.members.length;
				out.push({ px: c.sx / n, py: c.sy / n, n: n, members: c.members, one: n === 1 ? c.members[0] : null });
			}
			clusters = out;
			clustersK = k;
		}

		// Fetch the states for every admin-1 country whose box is in view (once each).
		function ensureAdmin1(vx0, vy0, vx1, vy1) {
			for (var i = 0; i < countryBoxes.length; i++) {
				var box = countryBoxes[i];
				if (box.x1 < vx0 || box.x0 > vx1 || box.y1 < vy0 || box.y0 > vy1) continue;
				if (admin1[box.a3]) continue;
				(function (a3) {
					var ctrl = window.AbortController ? new AbortController() : null;
					admin1[a3] = { state: "loading", ctrl: ctrl };
					fetch(ADMIN1_URL(a3), ctrl ? { signal: ctrl.signal } : undefined)
						.then(function (r) {
							if (!r.ok) throw new Error(a3 + " " + r.status);
							return r.json();
						})
						.then(function (topo) {
							admin1[a3].state = "ready";
							admin1[a3].mesh = window.topojson.mesh(topo, topo.objects.states);
							scheduleDraw();
						})
						.catch(function () {
							admin1[a3].state = "failed";
						});
				})(box.a3);
			}
		}

		function scheduleDraw() {
			if (frame) return;
			frame = requestAnimationFrame(draw);
		}

		function draw() {
			frame = 0;
			var t = transform;

			// Geography, under the zoom transform (vector strokes kept constant on screen via /k).
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, w, h);
			ctx.fillStyle = col.bg;
			ctx.fillRect(0, 0, w, h);
			ctx.save();
			ctx.translate(t.x, t.y);
			ctx.scale(t.k, t.k);

			ctx.beginPath();
			path(land);
			ctx.fillStyle = col.land;
			ctx.fill();

			ctx.beginPath();
			path(borders);
			ctx.strokeStyle = col.coast;
			ctx.lineWidth = 0.6 / t.k;
			ctx.stroke();

			if (t.k >= ADMIN1_K) {
				var vx0 = (0 - t.x) / t.k;
				var vy0 = (0 - t.y) / t.k;
				var vx1 = (w - t.x) / t.k;
				var vy1 = (h - t.y) / t.k;
				ensureAdmin1(vx0, vy0, vx1, vy1);
				ctx.strokeStyle = col.coast;
				ctx.lineWidth = 0.5 / t.k;
				ctx.globalAlpha = 0.9;
				for (var a3 in admin1) {
					var rec = admin1[a3];
					if (rec.state !== "ready") continue;
					ctx.beginPath();
					path(rec.mesh);
					ctx.stroke();
				}
				ctx.globalAlpha = 1;
			}
			ctx.restore();

			// Markers, in screen space so their size never changes with zoom.
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			if (clustersK !== t.k) rebuildClusters(t.k);
			visible = [];
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			for (var i = 0; i < clusters.length; i++) {
				var cl = clusters[i];
				var sx = cl.px * t.k + t.x;
				var sy = cl.py * t.k + t.y;
				if (sx < -HALO || sx > w + HALO || sy < -HALO || sy > h + HALO) continue;
				if (cl.n === 1) {
					var hot = hovered && hovered.one === cl.one;
					ctx.beginPath();
					ctx.arc(sx, sy, hot ? DOT_R + 1.4 : DOT_R, 0, 6.2832);
					ctx.fillStyle = hot ? col.dotHi : col.dot;
					ctx.globalAlpha = hot ? 1 : 0.72;
					ctx.fill();
					ctx.globalAlpha = 1;
				} else {
					var r = clamp(7 + Math.sqrt(cl.n) * 1.7, 9, 30);
					ctx.beginPath();
					ctx.arc(sx, sy, r, 0, 6.2832);
					ctx.fillStyle = col.dot;
					ctx.globalAlpha = 0.82;
					ctx.fill();
					ctx.globalAlpha = 1;
					ctx.lineWidth = 1.5;
					ctx.strokeStyle = col.accent;
					ctx.stroke();
					ctx.fillStyle = col.bg;
					ctx.font = "bold " + Math.round(clamp(r * 0.9, 9, 15)) + "px system-ui, sans-serif";
					ctx.fillText(cl.n >= 1000 ? Math.round(cl.n / 1000) + "k" : String(cl.n), sx, sy);
				}
				visible.push({ sx: sx, sy: sy, r: cl.n === 1 ? DOT_R + 3 : r, cl: cl });
			}
		}

		function markerAt(sx, sy) {
			// last drawn wins (topmost); iterate backwards
			for (var i = visible.length - 1; i >= 0; i--) {
				var m = visible[i];
				var dx = sx - m.sx;
				var dy = sy - m.sy;
				if (dx * dx + dy * dy <= m.r * m.r) return m;
			}
			return null;
		}

		function memberBounds(cl) {
			var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (var i = 0; i < cl.members.length; i++) {
				var p = cl.members[i];
				if (p.px < x0) x0 = p.px;
				if (p.px > x1) x1 = p.px;
				if (p.py < y0) y0 = p.py;
				if (p.py > y1) y1 = p.py;
			}
			return { x0: x0, y0: y0, x1: x1, y1: y1 };
		}

		// A cluster of co-located cameras (geo-IP puts many at the same city coords) can never
		// be split by zoom, so it opens a scrollable list instead — the way to reach those cams.
		var listEl = null;
		function closeList() {
			if (listEl) {
				listEl.remove();
				listEl = null;
			}
		}
		function openList(cl) {
			closeList();
			var panel = document.createElement("div");
			panel.className = "map-list";
			var head = document.createElement("header");
			head.textContent = cl.n.toLocaleString() + " cameras here";
			var x = document.createElement("button");
			x.type = "button";
			x.className = "map-list-x";
			x.setAttribute("aria-label", "close");
			x.textContent = "×";
			x.addEventListener("click", closeList);
			head.appendChild(x);
			panel.appendChild(head);
			var ul = document.createElement("ul");
			var shown = Math.min(cl.members.length, LIST_MAX);
			for (var i = 0; i < shown; i++) {
				(function (p) {
					var li = document.createElement("li");
					var a = document.createElement("a");
					a.href = p.href;
					a.textContent = p.title || "camera";
					a.addEventListener("click", function (e) {
						e.preventDefault();
						closeList();
						navigate(p);
					});
					li.appendChild(a);
					ul.appendChild(li);
				})(cl.members[i]);
			}
			panel.appendChild(ul);
			if (cl.members.length > LIST_MAX) {
				var more = document.createElement("p");
				more.className = "map-list-more";
				more.textContent = "showing " + LIST_MAX + " of " + cl.n.toLocaleString() + "; zoom in for fewer";
				panel.appendChild(more);
			}
			mapwrap.appendChild(panel);
			listEl = panel;
		}

		// ── pointer interaction ──────────────────────────────────────────────────
		var tip = document.createElement("div");
		tip.className = "map-tip";
		tip.hidden = true;
		mapwrap.appendChild(tip);

		var downX = 0;
		var downY = 0;
		var dragDist = 0;
		var hoverFrame = 0;

		function onDown(e) {
			downX = e.clientX;
			downY = e.clientY;
			dragDist = 0;
			closeList(); // panning or a fresh click dismisses an open list
		}
		function onUp(e) {
			dragDist = Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY);
		}
		function onMove(e) {
			if (hoverFrame) return;
			hoverFrame = requestAnimationFrame(function () {
				hoverFrame = 0;
				var rect = canvas.getBoundingClientRect();
				var m = markerAt(e.clientX - rect.left, e.clientY - rect.top);
				var next = m ? m.cl : null;
				canvas.style.cursor = m ? "pointer" : "grab";
				if (m) {
					tip.textContent = m.cl.n === 1 ? m.cl.one.title || "camera" : m.cl.n.toLocaleString() + " cameras";
					// canvas is offset within the positioned .mapwrap (the hint sits above it)
					tip.style.left = canvas.offsetLeft + m.sx + "px";
					tip.style.top = canvas.offsetTop + m.sy + "px";
					tip.hidden = false;
				} else {
					tip.hidden = true;
				}
				if (next !== hovered) {
					hovered = next;
					scheduleDraw();
				}
			});
		}
		function onLeave() {
			tip.hidden = true;
			if (hovered) {
				hovered = null;
				scheduleDraw();
			}
		}
		function onClick(e) {
			if (dragDist > 4) return; // that was a pan, not a click
			var rect = canvas.getBoundingClientRect();
			var m = markerAt(e.clientX - rect.left, e.clientY - rect.top);
			if (!m) return;
			if (m.cl.n === 1) {
				navigate(m.cl.one);
				return;
			}
			// Zoom to fit the cluster's members when zoom can still pull them apart; otherwise
			// (co-located, or already at max zoom) list the cameras so every one stays reachable.
			var b = memberBounds(m.cl);
			var bw = b.x1 - b.x0;
			var bh = b.y1 - b.y0;
			var canSplit = Math.max(bw, bh) > CLUSTER_PX / MAX_K;
			if (transform.k < MAX_K - 1e-3 && canSplit) {
				var fitK = clamp(0.7 * Math.min(w / Math.max(bw, 1e-9), h / Math.max(bh, 1e-9)), transform.k * 1.5, MAX_K);
				var cx = (b.x0 + b.x1) / 2;
				var cy = (b.y0 + b.y1) / 2;
				var target = d3.zoomIdentity.translate(w / 2, h / 2).scale(fitK).translate(-cx, -cy);
				d3.select(canvas).transition().duration(450).call(zoom.transform, target);
			} else {
				openList(m.cl);
			}
		}

		canvas.addEventListener("pointerdown", onDown);
		canvas.addEventListener("pointerup", onUp);
		canvas.addEventListener("pointermove", onMove);
		canvas.addEventListener("pointerleave", onLeave);
		canvas.addEventListener("click", onClick);
		function onKey(e) {
			if (e.key === "Escape") closeList();
		}
		document.addEventListener("keydown", onKey);

		// Redraw with fresh colours when the theme picker swaps the <html> class.
		var themeObs = new MutationObserver(function () {
			col = readColors();
			scheduleDraw();
		});
		themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

		var resizeObs = null;
		if (window.ResizeObserver) {
			resizeObs = new ResizeObserver(function () {
				sizeToContainer();
				scheduleDraw();
			});
			resizeObs.observe(mapwrap);
		} else {
			window.addEventListener("resize", onWinResize);
		}
		function onWinResize() {
			sizeToContainer();
			scheduleDraw();
		}

		// Go live: size, wire zoom, first paint, and retire the SVG (this also fires map.js's
		// teardown via live-lifecycle's removed-node observer, so its viewBox handlers detach).
		var hint = mapwrap.querySelector(".maphint");
		if (hint) hint.textContent = pts.length.toLocaleString() + " geolocated cameras · drag to pan, scroll or pinch to zoom, click a cluster to open it, a camera to view it";
		sizeToContainer();
		d3.select(canvas).call(zoom).on("dblclick.zoom", null);
		canvas.style.cursor = "grab";
		draw();
		canvas.__geo = {
			destroy: function () {
				if (frame) cancelAnimationFrame(frame);
				if (hoverFrame) cancelAnimationFrame(hoverFrame);
				themeObs.disconnect();
				if (resizeObs) resizeObs.disconnect();
				else window.removeEventListener("resize", onWinResize);
				for (var a3 in admin1) {
					if (admin1[a3].ctrl) {
						try {
							admin1[a3].ctrl.abort();
						} catch (x) {}
					}
				}
				try {
					d3.select(canvas).on(".zoom", null);
				} catch (x) {}
				document.removeEventListener("keydown", onKey);
				closeList();
				if (tip.parentNode) tip.remove();
			},
		};
		svg.remove();
	}

	// ── lifecycle wiring (mirrors map.js) ────────────────────────────────────────
	var collect = window.liveLifecycle.collect;

	function init(root) {
		root = root || document;
		var maps = root.querySelectorAll("svg.worldmap");
		for (var i = 0; i < maps.length; i++) startCanvas(maps[i]);
	}
	function teardown(root) {
		var canvases = collect(root, "canvas.worldmap-canvas");
		for (var i = 0; i < canvases.length; i++) {
			if (canvases[i].__geo) canvases[i].__geo.destroy();
		}
	}

	window.liveLifecycle.register({ init: init, teardown: teardown });
})();
