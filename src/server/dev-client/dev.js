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

	/**
	 * Read a chosen File as { mime, data } where data is base64, via readAsDataURL (robust
	 * for binary). The result is "data:<mime>;base64,<data>", so split off the prefix.
	 */
	function readImage(file) {
		return new Promise((resolve, reject) => {
			const fr = new FileReader();
			fr.onerror = () => reject(new Error("could not read file"));
			fr.onload = () => {
				const s = String(fr.result);
				const comma = s.indexOf(",");
				const mime = (s.slice(5, s.indexOf(";")) || file.type || "").trim();
				resolve({ mime, data: comma >= 0 ? s.slice(comma + 1) : "" });
			};
			fr.readAsDataURL(file);
		});
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
		// Cam shots show ref:port; cards (incl. cam cards, which now carry a data-port for
		// change-thumbnail) show just the ref, since their other actions target the whole ref.
		h.textContent = ctx.role === "shot" && ctx.port ? `${ctx.ref}:${ctx.port}` : ctx.ref;
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
		// Reorder pins a single screenshot: cam-only and per-shot.
		if (ctx.kind === "cam" && ctx.role === "shot") {
			menu.appendChild(itemButton("Reorder", "", () => doReorder(ctx)));
		}
		// Tag applies to every kind.
		menu.appendChild(itemButton("Tag", "", () => showTag(ctx)));
		// Change thumbnail: replace the stored image, for any kind, on a card or a shot.
		menu.appendChild(itemButton("Change thumbnail", "", () => showThumbnail(ctx)));
		// Feature toggles homepage-showcase membership, supported for every kind.
		if (ctx.kind === "cam" || ctx.kind === "stream" || ctx.kind === "feed") {
			menu.appendChild(featureItem(ctx));
		}
		// Blacklist removes a whole host and blocks re-scraping: a cam-only concept.
		if (ctx.kind === "cam") {
			menu.appendChild(itemButton("Blacklist", "danger", () => showBlacklist(ctx)));
		}
		// Remove is a plain delete (no re-scrape block), offered for every kind; a removed
		// entry returns on the next re-ingest.
		if (ctx.kind === "cam" || ctx.kind === "stream" || ctx.kind === "feed") {
			menu.appendChild(itemButton("Remove", "danger", () => showRemove(ctx)));
		}
	}

	// ── Reorder (per-shot, no sub-form) ────────────────────────────────────────────

	async function doReorder(ctx) {
		closeMenu();
		try {
			await api("/reorder", "POST", { ip: ctx.ref, port: Number(ctx.port) });
			toast(`pinned ${ctx.ref}:${ctx.port} as the card image. Run \`bun run bake\` to apply`);
		} catch (e) {
			toast(`reorder failed: ${e.message}`, "error");
		}
	}

	// ── Feature / Unfeature (toggle, no sub-form) ──────────────────────────────────

	/**
	 * A one-item toggle for homepage-feature membership. Its label mirrors current DB
	 * state, fetched async (like showTag's chip load) so the menu still opens instantly:
	 * the button ships disabled with a provisional label and enables once GET resolves.
	 * State lives on the button's dataset, so a second click toggles straight back. No
	 * confirm prompt (it's a reversible toggle), and no optimistic card change (featuring
	 * only affects which cards the next `bun run bake` shows on the homepage).
	 */
	function featureItem(ctx) {
		const b = itemButton("Feature…", "", null);
		b.dataset.state = ""; // "" (unknown) | "on" | "off"
		b.disabled = true; // can't click until we know the current state

		b.addEventListener("click", async () => {
			if (b.dataset.state === "") return; // guard the pre-resolve window
			const on = b.dataset.state !== "on"; // target is the opposite of current
			try {
				await api("/feature", "POST", { kind: ctx.kind, ref: ctx.ref, on });
				b.dataset.state = on ? "on" : "off";
				b.textContent = on ? "Unfeature" : "Feature"; // flip in place; menu stays open
				toast(`${on ? "featured" : "unfeatured"} ${ctx.ref}. run \`bun run bake\``);
			} catch (e) {
				toast(`feature failed: ${e.message}`, "error");
			}
		});

		// Resolve the label from current state. If the menu closes mid-fetch the button is
		// detached (isConnected false), so both paths no-op instead of touching a dead node.
		api(`/featured?kind=${encodeURIComponent(ctx.kind)}&ref=${encodeURIComponent(ctx.ref)}`, "GET")
			.then(({ featured }) => {
				if (!b.isConnected) return;
				b.dataset.state = featured ? "on" : "off";
				b.textContent = featured ? "Unfeature" : "Feature";
				b.disabled = false;
			})
			.catch(() => {
				if (!b.isConnected) return;
				b.dataset.state = "off";
				b.textContent = "Feature";
				b.disabled = false;
			});

		return b;
	}

	// ── Blacklist (confirm sub-form) ───────────────────────────────────────────────

	function showBlacklist(ctx) {
		menu.replaceChildren(menuHeader(ctx));
		const msg = document.createElement("p");
		msg.className = "dev-msg";
		msg.textContent = `Blacklist ${ctx.ref}? This removes every camera for this host from the DB.`;
		menu.appendChild(msg);

		const row = document.createElement("div");
		row.className = "dev-row";
		row.appendChild(actionButton("Cancel", "", () => showOptions(ctx)));
		row.appendChild(
			actionButton("Blacklist", "danger", async () => {
				try {
					const r = await api("/blacklist", "POST", { ip: ctx.ref });
					closeMenu();
					removeCard(ctx, "blacklisted");
					toast(`blacklisted ${ctx.ref}, removed ${r.deleted} camera(s). run \`bun run bake\``);
				} catch (e) {
					toast(`blacklist failed: ${e.message}`, "error");
				}
			}),
		);
		menu.appendChild(row);
		clampMenu();
	}

	// ── Remove (feed cam, confirm sub-form) ─────────────────────────────────────

	function showRemove(ctx) {
		menu.replaceChildren(menuHeader(ctx));
		const msg = document.createElement("p");
		msg.className = "dev-msg";
		msg.textContent =
			ctx.kind === "cam"
				? `Remove ${ctx.ref}? This drops every camera for this host from the DB; it comes back if you re-ingest.`
				: "Remove this cam from the DB? It comes back if you re-ingest its source list.";
		menu.appendChild(msg);

		const row = document.createElement("div");
		row.className = "dev-row";
		row.appendChild(actionButton("Cancel", "", () => showOptions(ctx)));
		row.appendChild(
			actionButton("Remove", "danger", async () => {
				try {
					await api("/remove", "POST", { kind: ctx.kind, ref: ctx.ref });
					closeMenu();
					removeCard(ctx, "removed");
					toast(`removed ${ctx.ref}. run \`bun run bake\``);
				} catch (e) {
					toast(`remove failed: ${e.message}`, "error");
				}
			}),
		);
		menu.appendChild(row);
		clampMenu();
	}

	// ── Tag (form + autocomplete) ──────────────────────────────────────────────────

	function showTag(ctx) {
		menu.replaceChildren(menuHeader(ctx));

		// Current tags for this entity, each removable (its × calls /untag). Sits above
		// the add form, so the one submenu both adds and removes tags.
		const chips = document.createElement("ul");
		chips.className = "dev-chips";
		menu.appendChild(chips);

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

		// Add one removable chip to the list (deduped). Its × removes the tag via /untag
		// and, on a detail page, drops it from the meta table optimistically.
		function addChip(tag) {
			for (const li of chips.children) if (li.dataset.tag === tag) return;
			const li = document.createElement("li");
			li.className = "dev-chip";
			li.dataset.tag = tag;
			li.append(document.createTextNode(tag));
			const x = document.createElement("button");
			x.type = "button";
			x.className = "dev-chip-x";
			x.setAttribute("aria-label", `Remove ${tag}`);
			x.textContent = "×";
			x.addEventListener("click", async () => {
				try {
					await api("/untag", "POST", { kind: ctx.kind, ref: ctx.ref, tag });
					li.remove();
					removeTagFromMeta(ctx, tag);
					toast(`untagged ${ctx.ref} #${tag}. run \`bun run bake\``);
					clampMenu();
				} catch (err) {
					toast(`untag failed: ${err.message}`, "error");
				}
			});
			li.appendChild(x);
			chips.appendChild(li);
		}

		// Load this entity's existing tags into the chip list.
		api(`/entity-tags?kind=${encodeURIComponent(ctx.kind)}&ref=${encodeURIComponent(ctx.ref)}`, "GET")
			.then((tags) => {
				for (const t of tags || []) addChip(t);
				clampMenu();
			})
			.catch(() => {});

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
				const r = await api("/tag", "POST", { kind: ctx.kind, ref: ctx.ref, tag });
				if (tagCache && !tagCache.includes(r.tag)) {
					tagCache.push(r.tag);
					tagCache.sort();
				}
				addTagToMeta(ctx, r.tag);
				addChip(r.tag);
				// Keep the menu open so several tags can be added/removed in one sitting.
				input.value = "";
				hideSuggest();
				input.focus();
				clampMenu();
				toast(
					r.added
						? `tagged ${ctx.ref} #${r.tag}. run \`bun run bake\``
						: `${ctx.ref} already tagged #${r.tag}`,
				);
			} catch (err) {
				toast(`tag failed: ${err.message}`, "error");
			}
		});
	}

	// ── Change thumbnail (file picker → confirm + permanence → upload) ─────────────────

	// Replace the menu with a file picker. Choosing a file goes straight to the confirm
	// step (no submit button); the change event only fires on an actual selection.
	function showThumbnail(ctx) {
		menu.replaceChildren(menuHeader(ctx));
		const msg = document.createElement("p");
		msg.className = "dev-msg";
		msg.textContent = "Choose an image to replace this thumbnail.";
		menu.appendChild(msg);

		const input = document.createElement("input");
		input.type = "file";
		input.className = "dev-file";
		input.accept = "image/*";
		input.addEventListener("change", () => {
			const file = input.files && input.files[0];
			if (file) confirmThumbnail(ctx, file);
		});
		menu.appendChild(input);
		clampMenu();
		input.focus();
	}

	// The are-you-sure step (like blacklist/remove), but with a permanence choice: Yes marks
	// the thumbnail permanent (a re-scan never overwrites it), No keeps it replaceable, Cancel
	// aborts. Both Yes and No upload; only the `permanent` flag differs.
	function confirmThumbnail(ctx, file) {
		menu.replaceChildren(menuHeader(ctx));
		const msg = document.createElement("p");
		msg.className = "dev-msg";
		msg.textContent =
			`Replace ${ctx.ref}'s thumbnail with "${file.name}". Make it permanent? ` +
			"Permanent thumbnails survive a re-scan of the source; otherwise the next scan can overwrite it.";
		menu.appendChild(msg);

		const upload = async (permanent) => {
			try {
				const { mime, data } = await readImage(file);
				const payload = { kind: ctx.kind, ref: ctx.ref, mime, data, permanent };
				if (ctx.kind === "cam") payload.port = Number(ctx.port);
				await api("/thumbnail", "POST", payload);
				closeMenu();
				toast(`updated thumbnail for ${ctx.ref}${permanent ? " (permanent)" : ""}. run \`bun run bake\``);
			} catch (e) {
				toast(`thumbnail failed: ${e.message}`, "error");
			}
		};

		const row = document.createElement("div");
		row.className = "dev-row";
		row.appendChild(actionButton("Yes", "accent", () => upload(true))); // permanent
		row.appendChild(actionButton("No", "", () => upload(false))); // replaceable
		row.appendChild(actionButton("Cancel", "", () => showOptions(ctx))); // abort, back to menu
		menu.appendChild(row);
		clampMenu();
	}

	// ── Optimistic DOM updates ─────────────────────────────────────────────────────

	function fadeRemove(el) {
		el.classList.add("dev-removing");
		setTimeout(() => el.remove(), 220);
	}

	// Per-kind gallery landing: the "back" target after removing an item on its detail page.
	const LISTINGS = {
		cam: { noun: "Host", href: "/hosts", snippet: "/hosts/index.snippet.html", label: "hosts" },
		stream: { noun: "Stream", href: "/streams", snippet: "/streams/index.snippet.html", label: "streams" },
		feed: { noun: "Cam", href: "/feeds", snippet: "/feeds/index.snippet.html", label: "feeds" },
	};

	// Optimistic update after a blacklist/remove. On a gallery (role "card") fade the matching
	// card(s); on a detail page ("shot") swap <main> for a "run `bun run bake`" notice plus a
	// link back to that kind's gallery. `verb` is the past-tense action shown in the notice.
	function removeCard(ctx, verb) {
		if (ctx.role === "card") {
			document.querySelectorAll(`.card[data-kind="${ctx.kind}"]`).forEach((el) => {
				if (el.dataset.ref === ctx.ref) fadeRemove(el);
			});
			return;
		}
		const main = document.querySelector("main");
		const L = LISTINGS[ctx.kind];
		if (!main || !L) return;
		const p = document.createElement("p");
		p.className = "empty";
		const code = document.createElement("code");
		code.textContent = "bun run bake";
		p.append(`${L.noun} ${ctx.ref} ${verb}. Run `, code, " to update the gallery.");
		const nav = document.createElement("p");
		const back = document.createElement("a");
		back.className = "back";
		back.href = L.href;
		back.setAttribute("hx-get", L.snippet);
		back.setAttribute("hx-push-url", L.href);
		back.innerHTML = `&larr; Back to ${L.label}`;
		nav.appendChild(back);
		main.replaceChildren(p, nav);
		if (window.htmx) window.htmx.process(main);
	}

	function addTagToMeta(ctx, tag) {
		if (ctx.role !== "shot") return; // only detail pages (host/stream/feed) render a Tags row
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

	function removeTagFromMeta(ctx, tag) {
		if (ctx.role !== "shot") return; // only detail pages render a Tags row
		for (const th of document.querySelectorAll(".meta th")) {
			if (th.textContent.trim() === "Tags") {
				const td = th.nextElementSibling;
				if (td) {
					const tags = td.textContent.split(",").map((s) => s.trim()).filter(Boolean).filter((t) => t !== tag);
					if (tags.length) td.textContent = tags.join(", ");
					else th.closest("tr").remove(); // last tag gone, drop the whole row
				}
				return;
			}
		}
	}

	// ── Wiring ───────────────────────────────────────────────────────────────────

	document.addEventListener("contextmenu", (e) => {
		// Suppress the native menu over our own menu, but keep it everywhere else.
		if (e.target.closest(".dev-menu")) {
			e.preventDefault();
			return;
		}
		// One hook system: any card or detail figure carrying data-kind/data-ref is
		// taggable. `role` (shot vs card) drives which actions show and whether the
		// optimistic Tags-row update runs; `kind` (cam/stream/feed) is the entity.
		const shot = e.target.closest(".shot[data-kind]");
		const card = e.target.closest(".card[data-kind]");
		const el = shot || card;
		if (!el || !el.dataset.kind || !el.dataset.ref) return; // native menu elsewhere
		const ctx = {
			role: shot ? "shot" : "card",
			kind: el.dataset.kind,
			ref: el.dataset.ref,
			port: el.dataset.port, // only cam shots carry this
		};
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

	// ── Import forms (the dev-only import view) ────────────────────────────────────
	// The nav "import" button hx-gets the form view into <main>, and each type button
	// swaps a per-type form into #import-form. This submit is delegated on document so
	// it survives those swaps with no re-binding; the forms carry no hx-*, so we own the
	// POST, clear the form, and toast exactly like the tag tool.

	function importSummary(type, r) {
		if (type === "youtube" && r.missing) return "that video wasn't found (deleted or private)";
		const base = `imported ${r.added} new, ${r.updated} refreshed`;
		if (type === "shodan" && r.skipped) return `${base}, ${r.skipped} skipped (no screenshot). run \`bun run bake\``;
		if (r.noThumb) return `${base} (no thumbnail). run \`bun run bake\``;
		return `${base}. run \`bun run bake\``;
	}

	document.addEventListener("submit", async (e) => {
		const form = e.target.closest("form.import-form");
		if (!form) return; // not ours (the tag form is form.dev-tagform, handled elsewhere)
		e.preventDefault();
		const type = form.dataset.importType;
		const fields = Object.fromEntries(new FormData(form)); // { json } or { url, label }
		try {
			const r = await api("/import", "POST", { type, ...fields });
			form.reset();
			toast(importSummary(type, r));
		} catch (err) {
			toast(`import failed: ${err.message}`, "error");
		}
	});
})();
