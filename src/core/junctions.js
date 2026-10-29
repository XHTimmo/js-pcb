'use strict';
const { EPS, pointSegmentDistance } = require('./geometry.js');

const cross = (ax, ay, bx, by) => ax * by - ay * bx;
const DIRECTION_EPS = 1e-10; // Unit-vector tolerance, much smaller than the turn-angle validation tolerance.

// A tolerance-aware index avoids the rounding-boundary misses of toFixed keys.
// Each plane has its own index: vias and projected crossings on other layers do
// not join planar directions. Copper width and pads do not create angle nodes.
function nodeIndex() {
	const buckets = new Map(),
		nodes = [];
	return {
		nodes,
		at(point) {
			const x = Math.floor(point[0] / EPS),
				y = Math.floor(point[1] / EPS);
			let closest,
				distance = Infinity;
			for (let dx = -1; dx <= 1; dx++)
				for (let dy = -1; dy <= 1; dy++) {
					for (const node of buckets.get(x + dx + ',' + (y + dy)) || []) {
						const d = Math.hypot(point[0] - node.point[0], point[1] - node.point[1]);
						if (d <= EPS && d < distance) {
							closest = node;
							distance = d;
						}
					}
				}
			if (closest) return closest;
			const node = { point: [point[0], point[1]], incident: new Set() };
			const key = x + ',' + y;
			if (!buckets.has(key)) buckets.set(key, []);
			buckets.get(key).push(node);
			nodes.push(node);
			return node;
		},
	};
}

function joinIntersections(index, a, b) {
	const join = (point) => {
		const node = index.at(point);
		node.incident.add(a);
		node.incident.add(b);
	};
	const det = cross(a.dx, a.dy, b.dx, b.dy);
	if (Math.abs(det) > DIRECTION_EPS) {
		// Use the actual crossing, not merely endpoints near the other line.
		// Otherwise subdividing a shallow crossing can invent extra junctions.
		const x = b.segment.a[0] - a.segment.a[0],
			y = b.segment.a[1] - a.segment.a[1];
		const t = cross(x, y, b.dx, b.dy) / det,
			u = cross(x, y, a.dx, a.dy) / det;
		if (t >= -EPS && t <= a.length + EPS && u >= -EPS && u <= b.length + EPS) {
			const along = Math.max(0, Math.min(a.length, t));
			join([a.segment.a[0] + along * a.dx, a.segment.a[1] + along * a.dy]);
		}
		return;
	}
	// Parallel/collinear contacts include both limits of an overlap. Joining
	// both segments supplies both trunk directions at an overlapping endpoint.
	for (const [line, other] of [
		[a, b],
		[b, a],
	])
		for (const point of [line.segment.a, line.segment.b]) {
			if (pointSegmentDistance(point, other.segment.a, other.segment.b) <= EPS) join(point);
		}
}

function directionsAt(node) {
	const directions = [];
	const add = (line, sign) => {
		const dx = sign * line.dx,
			dy = sign * line.dy;
		const existing = directions.find((ray) => ray.dx * dx + ray.dy * dy > 0 && Math.abs(cross(ray.dx, ray.dy, dx, dy)) <= DIRECTION_EPS);
		if (existing) existing.ids.add(line.segment.id);
		else directions.push({ dx, dy, segment: line.segment, ids: new Set([line.segment.id]) });
	};
	for (const line of node.incident) {
		const along = (node.point[0] - line.segment.a[0]) * line.dx + (node.point[1] - line.segment.a[1]) * line.dy;
		if (along > EPS) add(line, -1);
		if (along < line.length - EPS) add(line, 1);
	}
	return directions;
}

// Build a noded, direction-deduplicated graph for validation only. Original
// paths, fixed copper and SES output are never split or otherwise mutated.
function buildPlanarJunctions(segments) {
	const planes = new Map(),
		junctions = [];
	for (const segment of segments) {
		if (segment.via) continue;
		const x = segment.b[0] - segment.a[0],
			y = segment.b[1] - segment.a[1],
			length = Math.hypot(x, y);
		if (length <= EPS) continue;
		const key = JSON.stringify([segment.net, segment.a[2]]);
		if (!planes.has(key)) planes.set(key, []);
		planes.get(key).push({
			segment,
			length,
			dx: x / length,
			dy: y / length,
			minX: Math.min(segment.a[0], segment.b[0]),
			maxX: Math.max(segment.a[0], segment.b[0]),
			minY: Math.min(segment.a[1], segment.b[1]),
			maxY: Math.max(segment.a[1], segment.b[1]),
		});
	}
	for (const lines of planes.values()) {
		const index = nodeIndex();
		lines.sort((a, b) => a.minX - b.minX || a.minY - b.minY || a.maxX - b.maxX || a.maxY - b.maxY);
		for (const line of lines) for (const point of [line.segment.a, line.segment.b]) index.at(point).incident.add(line);
		for (let i = 0; i < lines.length; i++)
			for (let j = i + 1; j < lines.length; j++) {
				const a = lines[i],
					b = lines[j];
				if (b.minX > a.maxX + EPS) break;
				if (b.minY > a.maxY + EPS || a.minY > b.maxY + EPS) continue;
				joinIntersections(index, a, b);
			}
		for (const node of index.nodes) {
			const directions = directionsAt(node);
			if (directions.length > 1) junctions.push(directions);
		}
	}
	return junctions;
}
module.exports = { buildPlanarJunctions };
