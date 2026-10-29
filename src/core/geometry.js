'use strict';

const EPS = 1e-7;
function pointSegmentDistance(p, a, b) {
	const dx = b[0] - a[0],
		dy = b[1] - a[1];
	const length2 = dx * dx + dy * dy;
	const t = length2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
	return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function segmentDistance(a, b, c, d) {
	const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
	const abC = cross(a, b, c),
		abD = cross(a, b, d),
		cdA = cross(c, d, a),
		cdB = cross(c, d, b);
	if (((abC > EPS && abD < -EPS) || (abC < -EPS && abD > EPS)) && ((cdA > EPS && cdB < -EPS) || (cdA < -EPS && cdB > EPS))) return 0;
	return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}
function pointInPolygon(p, polygon) {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i],
			b = polygon[j];
		if (pointSegmentDistance(p, a, b) < EPS) return true;
		if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
	}
	return inside;
}
function polygonDistance(a, b, polygon) {
	if (pointInPolygon(a, polygon) || pointInPolygon(b, polygon)) return 0;
	let distance = Infinity;
	for (let i = 0; i < polygon.length; i++) distance = Math.min(distance, segmentDistance(a, b, polygon[i], polygon[(i + 1) % polygon.length]));
	return distance;
}
function padDistance(a, b, terminal, layer) {
	const shape = terminal[5]?.[layer];
	const radius = shape ? shape.r : terminal[0];
	const points = (shape ? shape.points : terminal[3]).map((p) => [p[0] + terminal[2][0], p[1] + terminal[2][1]]);
	if (!points.length) return Math.max(0, pointSegmentDistance(terminal[2], a, b) - radius);
	if (points.length > 2) return Math.max(0, polygonDistance(a, b, points) - radius);
	return Math.max(0, segmentDistance(a, b, points[0], points[1]) - radius);
}
function groups(items, touches) {
	const parent = items.map((_, i) => i);
	const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
	for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (touches(items[i], items[j])) parent[find(j)] = find(i);
	const result = new Map();
	items.forEach((item, i) => {
		const key = find(i);
		if (!result.has(key)) result.set(key, []);
		result.get(key).push(item);
	});
	return [...result.values()];
}
module.exports = { EPS, pointSegmentDistance, segmentDistance, pointInPolygon, polygonDistance, padDistance, groups };
