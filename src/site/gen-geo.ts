#!/usr/bin/env bun
// Offline generator for the JS map's vector data (assets/geo/**). Downloads Natural
// Earth (public domain) admin-0 countries (110m) and admin-1 states/provinces (10m),
// simplifies + quantizes them to TopoJSON, and writes:
//
//   assets/geo/world.json            — every country outline; loaded when the canvas map inits
//   assets/geo/admin1/<ADM0_A3>.json — one country's states/provinces; lazy-loaded on zoom
//
// Each country in world.json carries id = ADM0_A3 and, when a matching admin-1 file
// exists, properties.a1 = 1 — so the client knows which sub-map to fetch without probing
// for 404s. Output is committed (like src/site/worldmap.ts), so `bun run bake` needs no
// network. Re-run with `bun run gen-geo` when refreshing the boundaries.
//
// Natural Earth is public domain: https://www.naturalearthdata.com/about/terms-of-use/

import { topology } from "topojson-server";
import { presimplify, simplify, quantile, sphericalTriangleArea } from "topojson-simplify";
import { quantize } from "topojson-client";
import type { GeometryCollection, Objects, Topology } from "topojson-specification";
import { mkdir, rm, writeFile } from "node:fs/promises";

const NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";
const ADMIN0_URL = `${NE}/ne_110m_admin_0_countries.geojson`;
const ADMIN1_URL = `${NE}/ne_10m_admin_1_states_provinces.geojson`;
const OUT_DIR = "assets/geo";
const ADMIN1_DIR = `${OUT_DIR}/admin1`;

// Simplification: keep this fraction of each layer's points (higher = more detail, bigger
// files), then snap coordinates to an integer grid of this many steps across the bbox.
const WORLD_KEEP = 0.6; // 110m is already coarse; trim gently
const ADMIN1_KEEP = 0.35; // 10m is dense; trim harder — these are lazy sub-maps
const WORLD_QUANT = 1e4;
const ADMIN1_QUANT = 2e4;

interface Feature {
	type: "Feature";
	properties: Record<string, unknown>;
	geometry: unknown;
}
interface FeatureCollection {
	type: "FeatureCollection";
	features: Feature[];
}

async function getGeojson(url: string): Promise<FeatureCollection> {
	process.stdout.write(`  fetching ${url.split("/").pop()} … `);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	const json = (await res.json()) as FeatureCollection;
	console.log(`${json.features.length} features`);
	return json;
}

/** Build → presimplify → simplify → quantize a FeatureCollection into a compact TopoJSON. */
function toTopo(name: string, fc: FeatureCollection, keep: number, quant: number): Topology<Objects<{}>> {
	// topojson-server types its output with nullable GeoJSON props; the simplify/quantize
	// types want non-null props. Cast once — the runtime shape is identical.
	let topo = topology({ [name]: fc as never }) as unknown as Topology<Objects<{}>>;
	topo = presimplify(topo, sphericalTriangleArea);
	// quantile(topo, p) is the weight at percentile p; simplify keeps points ABOVE it,
	// so to retain `keep` of the points we drop the bottom (1 - keep).
	const minWeight = quantile(topo, 1 - keep);
	topo = simplify(topo, minWeight);
	return quantize(topo, quant);
}

async function bytes(path: string): Promise<string> {
	const kb = Bun.file(path).size / 1024;
	return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`;
}

async function main(): Promise<void> {
	console.log("Generating map geo data from Natural Earth:");
	const [admin0, admin1] = await Promise.all([getGeojson(ADMIN0_URL), getGeojson(ADMIN1_URL)]);

	await rm(OUT_DIR, { recursive: true, force: true });
	await mkdir(ADMIN1_DIR, { recursive: true });

	// ── admin-1: group states by their country's ADM0_A3, one file per country ──────
	const byCountry = new Map<string, Feature[]>();
	for (const f of admin1.features) {
		const a3 = String((f.properties.adm0_a3 ?? "") as string).toUpperCase();
		if (!a3 || a3 === "-99") continue;
		(byCountry.get(a3) ?? byCountry.set(a3, []).get(a3)!).push({
			type: "Feature",
			properties: {}, // borders only — drop every property to keep sub-maps tiny
			geometry: f.geometry,
		});
	}
	const withAdmin1 = new Set<string>();
	let a1Bytes = 0;
	for (const [a3, feats] of byCountry) {
		const topo = toTopo("states", { type: "FeatureCollection", features: feats }, ADMIN1_KEEP, ADMIN1_QUANT);
		const path = `${ADMIN1_DIR}/${a3}.json`;
		await writeFile(path, JSON.stringify(topo));
		withAdmin1.add(a3);
		a1Bytes += Bun.file(path).size;
	}
	console.log(`  wrote ${withAdmin1.size} admin-1 files (${(a1Bytes / 1024 / 1024).toFixed(1)} MB total) to ${ADMIN1_DIR}/`);

	// ── world: every country, id = ADM0_A3, a1 flag when a sub-map exists ────────────
	const countries: Feature[] = admin0.features.map((f) => {
		const a3 = String((f.properties.ADM0_A3 ?? "") as string).toUpperCase();
		return {
			type: "Feature",
			properties: withAdmin1.has(a3) ? { name: f.properties.NAME, a1: 1 } : { name: f.properties.NAME },
			geometry: f.geometry,
			// id is carried onto the topology geometry below
			...(a3 ? { id: a3 } : {}),
		} as Feature & { id?: string };
	});
	const world = toTopo("countries", { type: "FeatureCollection", features: countries }, WORLD_KEEP, WORLD_QUANT);
	// topology() preserves feature `id` onto each geometry; make sure the a1 flag rode along.
	const geoms = (world.objects.countries as GeometryCollection).geometries;
	const flagged = geoms.filter((g) => (g.properties as Record<string, unknown> | undefined)?.a1 === 1).length;
	const worldPath = `${OUT_DIR}/world.json`;
	await writeFile(worldPath, JSON.stringify(world));
	console.log(`  wrote ${geoms.length} countries (${flagged} with admin-1) to ${worldPath} (${await bytes(worldPath)})`);
	console.log("Done. Commit assets/geo/ and re-bake.");
}

await main();
