import { rmSync } from "node:fs";
import { E2E_ROOT } from "../../playwright.config.ts";

export default function globalTeardown(): void {
	rmSync(E2E_ROOT, { recursive: true, force: true });
}
