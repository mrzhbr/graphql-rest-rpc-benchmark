import { createHash } from "node:crypto";
import type { Request, Response } from "express";

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort((left, right) => left.localeCompare(right))
			.map(
				(key) =>
					`${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function sendCacheableJson(
	req: Request,
	res: Response,
	payload: unknown,
	{ maxAgeSeconds = 30 } = {},
): void {
	const body = stableStringify(payload);
	const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;

	res.set({
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": `public, max-age=${maxAgeSeconds}`,
		ETag: etag,
	});

	if (req.headers["if-none-match"] === etag) {
		res.status(304).end();
		return;
	}

	res.status(200).send(body);
}
