'use strict';
const geometry = require('./geometry.js');
const { RouteError } = require('./options.js');
const WORLD_PER_MIL = 0.254;

function prepareConstraints(pcb, info, layers, config, gap) {
	const transform = (p) => [(p[0] - info.minx) * WORLD_PER_MIL + gap, (info.maxy - p[1]) * WORLD_PER_MIL + gap];
	const layerIndex = (value) => {
		const index =
			typeof value === 'number'
				? value
				: layers.findIndex(
						(name) => name === value || (name === 'TopLayer' && value === 'F.Cu') || (name === 'BottomLayer' && value === 'B.Cu'),
					);
		if (!Number.isInteger(index) || index < 0 || index >= layers.length) throw new RouteError('INVALID_LAYER', 'Unknown copper layer: ' + value);
		return index;
	};
	const keepouts = (config.constraints?.keepouts || []).map((region) => {
		const points = region.polygon.map(transform);
		if (points.length > 3 && geometry.pointSegmentDistance(points[0], points[points.length - 1], points[points.length - 1]) < geometry.EPS)
			points.pop();
		const area = points.reduce((sum, p, i) => sum + p[0] * points[(i + 1) % points.length][1] - p[1] * points[(i + 1) % points.length][0], 0);
		if (Math.abs(area) < geometry.EPS) throw new RouteError('INVALID_KEEPOUT', 'Keepout polygon has no area', [region.id]);
		for (let i = 0; i < points.length; i++)
			for (let j = i + 1; j < points.length; j++) {
				if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
				if (geometry.segmentDistance(points[i], points[(i + 1) % points.length], points[j], points[(j + 1) % points.length]) < geometry.EPS)
					throw new RouteError('INVALID_KEEPOUT', 'Self-intersecting keepout polygon', [region.id]);
			}
		return {
			id: region.id,
			points,
			layers: region.layer === 'all' ? layers.map((_, i) => i) : [layerIndex(region.layer)],
			gap: (region.clearanceMil || 0) * WORLD_PER_MIL,
			kind: region.kind || 'copper',
		};
	});
	const fixedRoutes = [];
	for (const route of config.constraints?.fixedRoutes || []) {
		if (!pcb[1].some((track) => track[5] === route.net))
			throw new RouteError('UNKNOWN_NET', 'Unknown fixed-route net: ' + route.net, [route.id], route.net);
		const layer = layerIndex(route.layer);
		for (const [index, segment] of route.segments.entries())
			fixedRoutes.push({
				id: route.id + ':' + index,
				sourceId: route.id,
				net: route.net,
				radius: (segment.width * WORLD_PER_MIL) / 2,
				points: [transform(segment.start).concat(layer), transform(segment.end).concat(layer)],
			});
	}
	const gapFor = (net) => pcb[1].find((track) => track[5] === net)?.[2] || 0;
	const fail = (fixed, objectId, message) => {
		throw new RouteError('FIXED_ROUTE_CONFLICT', message, [fixed.sourceId, objectId], fixed.net);
	};
	for (let i = 0; i < fixedRoutes.length; i++) {
		const fixed = fixedRoutes[i],
			[a, b] = fixed.points;
		for (const point of fixed.points)
			if (point[0] < 0 || point[1] < 0 || point[0] >= pcb[0][0] || point[1] >= pcb[0][1])
				fail(fixed, 'board-outline', 'Fixed route lies outside the routing grid');
		if (pcb[2]?.length) {
			if (!geometry.pointInPolygon(a, pcb[2][0]) || !geometry.pointInPolygon(b, pcb[2][0]))
				fail(fixed, 'board-outline', 'Fixed route lies outside the board');
			for (const outline of pcb[2])
				for (let j = 0; j < outline.length; j++) {
					if (geometry.segmentDistance(a, b, outline[j], outline[(j + 1) % outline.length]) + geometry.EPS < fixed.radius + pcb[3])
						fail(fixed, 'board-outline', 'Fixed route violates board-edge clearance');
				}
			for (const hole of pcb[2].slice(1))
				if (geometry.pointInPolygon(a, hole) || geometry.pointInPolygon(b, hole))
					fail(fixed, 'board-cutout', 'Fixed route lies inside a board cutout');
		}
		for (const region of keepouts)
			if (
				region.kind === 'copper' &&
				region.layers.includes(a[2]) &&
				geometry.polygonDistance(a, b, region.points) < fixed.radius + Math.max(gapFor(fixed.net), region.gap) + geometry.EPS
			)
				fail(fixed, region.id, 'Fixed route conflicts with a keepout');
		for (let j = 0; j < i; j++) {
			const other = fixedRoutes[j];
			if (
				other.net !== fixed.net &&
				other.points[0][2] === a[2] &&
				geometry.segmentDistance(a, b, ...other.points) + geometry.EPS <
					fixed.radius + other.radius + Math.max(gapFor(fixed.net), gapFor(other.net))
			)
				fail(fixed, other.sourceId, 'Fixed routes on different nets violate copper clearance');
		}
		for (const track of pcb[1]) {
			if (track[5] === fixed.net) continue;
			for (const [index, pad] of track[3].entries()) {
				if (pad[4]?.length && !pad[4].includes(a[2])) continue;
				if (geometry.padDistance(a, b, pad, a[2]) + geometry.EPS < fixed.radius + Math.max(gapFor(fixed.net), pad[1]))
					fail(fixed, 'pad:' + (track[5] || 'unassigned') + ':' + index, 'Fixed route conflicts with another pad');
			}
		}
	}
	return { fixedRoutes, keepouts, transform };
}
module.exports = { prepareConstraints, WORLD_PER_MIL };
