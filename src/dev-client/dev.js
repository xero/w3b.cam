// Dev-mode context menu. Injected only by `bun dev` (never in production). Right-click
// a gallery card or a per-host screenshot to drive the blacklist / reorder / tag
// endpoints in src/dev.ts. All events are delegated on `document` so the menu keeps
// working across htmx <main> swaps; the menu and toast live on <body>, outside <main>.

(() => {
	"use strict";

	const API = "/__dev";
	let menu = null; // the open .dev-menu element, or null
	let toastTimer = null;
	let tagCache = null; // string[] of existing tags, lazy-loaded once

	// ── Backend ──────────────────────────────────────────────────────────────────

	async function api(path, method, payload) {
		const res = await fetch(API + path, {
			method,
			headers: payload ? { "content-type": "application/json" } : undefined,
			body: payload ? JSON.stringify(payload) : undefined,
		});
		let data = null;
		try {
			data = await res.json();
		} catch {}
		if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
		return data;
	}

	async function ensureTags() {
		if (tagCache) return tagCache;
		try {
			tagCache = await api("/tags", "GET");
		} catch {
			tagCache = [];
		}
		return tagCache;
	}

	// ── Toast ──────────────────────────────────────────────────────────────────────

	function toast(message, kind = "info") {
		let el = document.querySelector(".dev-toast");
		if (!el) {
			el = document.createElement("div");
			el.className = "dev-toast";
			document.body.appendChild(el);
		}
		el.textContent = message;
		el.dataset.kind = kind;
		el.classList.add("show");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => el.classList.remove("show"), 3400);
	}

	// ── Menu lifecycle ───────────────────────────────────────────────────────────

	function closeMenu() {
		if (menu) {
			menu.remove();
			menu = null;
		}
	}

	/** Nudge the open menu fully on-screen after its size changes. */
	function clampMenu() {
		if (!menu) return;
		const pad = 8;
		const r = menu.getBoundingClientRect();
		if (r.right > innerWidth - pad) menu.style.left = `${Math.max(pad, innerWidth - pad - r.width)}px`;
		if (r.bottom > innerHeight - pad) menu.style.top = `${Math.max(pad, innerHeight - pad - r.height)}px`;
	}

	function openMenu(x, y, ctx) {
		closeMenu();
		menu = document.createElement("div");
		menu.className = "dev-menu";
		menu.setAttribute("role", "menu");
		menu.style.left = `${x}px`;
		menu.style.top = `${y}px`;
		// Keep clicks inside the menu from reaching the outside-click closer below.
		// Options swap the menu's contents (replaceChildren), which detaches the
		// clicked button; a bubbled click would fail `menu.contains(target)` and
		// wrongly close the menu before the sub-form is seen.
		menu.addEventListener("click", (e) => e.stopPropagation());
		document.body.appendChild(menu);
		showOptions(ctx);
		clampMenu();
	}

	function menuHeader(ctx) {
		const h = document.createElement("div");
		h.className = "dev-head";
		h.textContent = ctx.kind === "shot" ? `${ctx.ip}:${ctx.port}` : ctx.ip;
		return h;
	}

	function itemButton(label, cls, onClick) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = cls ? `dev-item ${cls}` : "dev-item";
		b.setAttribute("role", "menuitem");
		b.textContent = label;
		b.addEventListener("click", onClick);
		return b;
	}

	function actionButton(label, cls, onClick) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = cls ? `dev-btn ${cls}` : "dev-btn";
		b.textContent = label;
		b.addEventListener("click", onClick);
		return b;
	}

	// ── Top-level options ──────────────────────────────────────────────────────────

	function showOptions(ctx) {
		menu.replaceChildren(menuHeader(ctx));
		// Reorder pins a single screenshot, so it only makes sense per-shot.
		if (ctx.kind === "shot") {
			menu.appendChild(itemButton("Reorder", "", () => doReorder(ctx)));
		}
		menu.appendChild(itemButton("Tag", "", () => showTag(ctx)));
		menu.appendChild(itemButton("Blacklist", "danger", () => showBlacklist(ctx)));
	}

	// ── Reorder (per-shot, no sub-form) ────────────────────────────────────────────

	async function doReorder(ctx) {
		closeMenu();
		try {
			await api("/reorder", "POST", { ip: ctx.ip, port: Number(ctx.port) });
			toast(`pinned ${ctx.ip}:${ctx.port} as the card image. Run \`bun run bake\` to apply`);
		} catch (e) {
			toast(`reorder failed: ${e.message}`, "error");
		}
	}

	// ── Blacklist (confirm sub-form) ───────────────────────────────────────────────

	function showBlacklist(ctx) {
		menu.replaceChildren(menuHeader(ctx));
		const msg = document.createElement("p");
		msg.className = "dev-msg";
		msg.textContent = `Blacklist ${ctx.ip}? This removes every camera for this host from the DB.`;
		menu.appendChild(msg);

		const row = document.createElement("div");
		row.className = "dev-row";
		row.appendChild(actionButton("Cancel", "", () => showOptions(ctx)));
		row.appendChild(
			actionButton("Blacklist", "danger", async () => {
				try {
					const r = await api("/blacklist", "POST", { ip: ctx.ip });
					closeMenu();
					removeHost(ctx);
					toast(`blacklisted ${ctx.ip}, removed ${r.deleted} camera(s). run \`bun run bake\``);
				} catch (e) {
					toast(`blacklist failed: ${e.message}`, "error");
				}
			}),
		);
		menu.appendChild(row);
		clampMenu();
	}

	// ── Tag (form + autocomplete) ──────────────────────────────────────────────────

	function showTag(ctx) {
		menu.replaceChildren(menuHeader(ctx));

		const form = document.createElement("form");
		form.className = "dev-tagform";

		const wrap = document.createElement("div");
		wrap.className = "dev-inputwrap";
		const input = document.createElement("input");
		input.type = "text";
		input.className = "dev-input";
		input.placeholder = "tag name";
		input.autocomplete = "off";
		input.spellcheck = false;
		const suggest = document.createElement("ul");
		suggest.className = "dev-suggest";
		wrap.append(input, suggest);

		const add = document.createElement("button");
		add.type = "submit";
		add.className = "dev-btn accent";
		add.textContent = "Add";

		form.append(wrap, add);
		menu.appendChild(form);
		clampMenu();
		input.focus();

		// Autocomplete state, closed over by the handlers below.
		let matches = [];
		let active = -1;

		function setActive(i) {
			active = i;
			[...suggest.children].forEach((li, idx) => li.classList.toggle("active", idx === i));
		}

		function hideSuggest() {
			matches = [];
			active = -1;
			suggest.replaceChildren();
			suggest.classList.remove("show");
		}

		function renderSuggest() {
			const q = input.value.trim().toLowerCase();
			matches = q ? (tagCache || []).filter((t) => t.includes(q) && t !== q).slice(0, 8) : [];
			suggest.replaceChildren();
			active = -1;
			for (const m of matches) {
				const li = document.createElement("li");
				li.className = "dev-sug";
				li.textContent = m;
				// mousedown (not click) so it fires before the input loses focus.
				li.addEventListener("mousedown", (ev) => {
					ev.preventDefault();
					input.value = m;
					hideSuggest();
					input.focus();
				});
				suggest.appendChild(li);
			}
			suggest.classList.toggle("show", matches.length > 0);
			clampMenu();
		}

		input.addEventListener("input", () => {
			ensureTags().then(renderSuggest);
		});

		input.addEventListener("keydown", (e) => {
			if (e.key === "ArrowDown" && matches.length) {
				e.preventDefault();
				setActive((active + 1) % matches.length);
			} else if (e.key === "ArrowUp" && matches.length) {
				e.preventDefault();
				setActive((active - 1 + matches.length) % matches.length);
			} else if (e.key === "Tab" && active >= 0) {
				e.preventDefault();
				input.value = matches[active];
				hideSuggest();
			} else if (e.key === "Enter" && active >= 0) {
				e.preventDefault();
				input.value = matches[active];
				hideSuggest();
			} else if (e.key === "Escape" && suggest.classList.contains("show")) {
				// Swallow Esc so it dismisses the dropdown, not the whole menu.
				e.preventDefault();
				e.stopPropagation();
				hideSuggest();
			}
		});

		form.addEventListener("submit", async (e) => {
			e.preventDefault();
			const tag = input.value.trim();
			if (!tag) {
				input.focus();
				return;
			}
			try {
				const r = await api("/tag", "POST", { ip: ctx.ip, tag });
				closeMenu();
				if (tagCache && !tagCache.includes(r.tag)) {
					tagCache.push(r.tag);
					tagCache.sort();
				}
				addTagToMeta(ctx, r.tag);
				toast(
					r.added
						? `tagged ${ctx.ip} #${r.tag}. run \`bun run bake\``
						: `${ctx.ip} already tagged #${r.tag}`,
				);
			} catch (err) {
				toast(`tag failed: ${err.message}`, "error");
			}
		});
	}

	// ── Optimistic DOM updates ─────────────────────────────────────────────────────

	function fadeRemove(el) {
		el.classList.add("dev-removing");
		setTimeout(() => el.remove(), 220);
	}

	function removeHost(ctx) {
		if (ctx.kind === "card") {
			// Gallery: drop the matching card(s) from the grid.
			document.querySelectorAll(".card[data-ip]").forEach((el) => {
				if (el.dataset.ip === ctx.ip) fadeRemove(el);
			});
			return;
		}
		// Host page: the whole page is this IP; replace the content with a notice.
		const main = document.querySelector("main");
		if (!main) return;
		const p = document.createElement("p");
		p.className = "empty";
		const code = document.createElement("code");
		code.textContent = "bun run bake";
		p.append(`Host ${ctx.ip} blacklisted. Run `, code, " to update the gallery.");
		const nav = document.createElement("p");
		const back = document.createElement("a");
		back.className = "back";
		back.href = "/";
		back.setAttribute("hx-get", "/snips/page001.html");
		back.setAttribute("hx-push-url", "/");
		back.innerHTML = "&larr; Back to gallery";
		nav.appendChild(back);
		main.replaceChildren(p, nav);
		if (window.htmx) window.htmx.process(main);
	}

	function addTagToMeta(ctx, tag) {
		if (ctx.kind !== "shot") return; // cards don't render tags
		for (const th of document.querySelectorAll(".meta th")) {
			if (th.textContent.trim() === "Tags") {
				const td = th.nextElementSibling;
				if (td) {
					const tags = td.textContent.split(",").map((s) => s.trim()).filter(Boolean);
					if (!tags.includes(tag)) td.textContent = [...tags, tag].join(", ");
				}
				return;
			}
		}
		// No Tags row yet, so append one to the metadata table.
		const tbody = document.querySelector(".meta tbody");
		if (!tbody) return;
		const tr = document.createElement("tr");
		const th = document.createElement("th");
		th.scope = "row";
		th.textContent = "Tags";
		const td = document.createElement("td");
		td.textContent = tag;
		tr.append(th, td);
		tbody.appendChild(tr);
	}

	// ── Wiring ───────────────────────────────────────────────────────────────────

	document.addEventListener("contextmenu", (e) => {
		// Suppress the native menu over our own menu, but keep it everywhere else.
		if (e.target.closest(".dev-menu")) {
			e.preventDefault();
			return;
		}
		const shot = e.target.closest(".shot[data-ip]");
		const card = e.target.closest(".card[data-ip]");
		let ctx = null;
		if (shot) ctx = { kind: "shot", ip: shot.dataset.ip, port: shot.dataset.port };
		else if (card) ctx = { kind: "card", ip: card.dataset.ip };
		if (!ctx || !ctx.ip) return; // native menu elsewhere
		e.preventDefault();
		openMenu(e.clientX, e.clientY, ctx);
	});

	document.addEventListener("click", (e) => {
		if (menu && !menu.contains(e.target)) closeMenu();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") closeMenu();
	});
	window.addEventListener("scroll", closeMenu, true);
	document.addEventListener("htmx:beforeSwap", closeMenu);
})();
