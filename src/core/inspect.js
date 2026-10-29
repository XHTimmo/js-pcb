'use strict';
const geometry = require('./geometry.js');
const { WORLD_PER_MIL } = require('./constraints.js');
const { buildPlanarJunctions } = require('./junctions.js');

function netConnected(track, segments) {
	const copper = segments.filter((segment) => segment.net === track[5]);
	const pads = track[3].map((pad) => ({ pad }));
	const groups = geometry.groups([...copper, ...pads], (a, b) => {
		if (!a.pad && !b.pad)
			return (
				Math.max(Math.min(a.a[2], a.b[2]), Math.min(b.a[2], b.b[2])) <= Math.min(Math.max(a.a[2], a.b[2]), Math.max(b.a[2], b.b[2])) &&
				geometry.segmentDistance(a.a, a.b, b.a, b.b) <= a.radius + b.radius + geometry.EPS
			);
		if (a.pad && !b.pad) [a, b] = [b, a];
		if (!a.pad)
			return (b.pad[4] || []).some(
				(z) =>
					z >= Math.min(a.a[2], a.b[2]) &&
					z <= Math.max(a.a[2], a.b[2]) &&
					geometry.padDistance(a.a, a.b, b.pad, z) <= a.radius + geometry.EPS,
			);
		return (a.pad[4] || []).some(
			(z) =>
				(b.pad[4] || []).includes(z) && geometry.padDistance(a.pad[2], a.pad[2], b.pad, z) <= (a.pad[5]?.[z]?.r ?? a.pad[0]) + geometry.EPS,
		);
	});
	return groups.length === 1 && (copper.length > 0 || pads.length > 0);
}

function inspectResult(data, input, config, constraints) {
	const segments = [],
		violations = [],
		viaKeys = new Set();
	let tracks = 0,
		diagonalSegments = 0,
		rightAngleTurns = 0;
	const addViolation = (ruleId, code, message, net, ids, measured, required, unit = 'mil') =>
		violations.push({ ruleId, code, severity: 'error', message, net, objectIds: ids, measured, required, unit });
	const ruleChecks = Object.keys(config.rules || {})
		.filter((key) => key !== 'skillVersion')
		.map((ruleId) => ({
			ruleId,
			status: 'passed',
			implementation: ['allowedTurnAnglesDeg', 'forbidRightAngle'].includes(ruleId) ? 'validation' : 'enforced',
		}));
	for (const [trackIndex, track] of data[1].entries()) {
		const net = track[5] || 'net-' + trackIndex;
		for (const [pathIndex, path] of track[4].entries())
			for (let i = 1; i < path.length; i++) {
				const a = path[i - 1],
					b = path[i];
				if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) continue;
				const via = a[2] !== b[2];
				const radius = via ? track[1] : track[0];
				const id = track[6]?.id || 'route:' + net + ':' + pathIndex + ':' + i;
				const segment = { a, b, net, radius, gap: track[2], id, via };
				segments.push(segment);
				if (via) viaKeys.add(net + ':' + a[0] + ',' + a[1] + ',' + Math.min(a[2], b[2]) + ',' + Math.max(a[2], b[2]));
				else {
					tracks++;
					if (Math.abs(a[0] - b[0]) > geometry.EPS && Math.abs(a[1] - b[1]) > geometry.EPS) diagonalSegments++;
				}
			}
	}
	for (const junction of buildPlanarJunctions(segments))
		for (let i = 0; i < junction.length; i++)
			for (let j = i + 1; j < junction.length; j++) {
				const a = junction[i],
					b = junction[j];
				const dot = (a.dx * b.dx + a.dy * b.dy) / Math.hypot(a.dx, a.dy) / Math.hypot(b.dx, b.dy);
				const angle = 180 - (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
				if (angle < 1e-5 || Math.abs(angle - 180) < 1e-5) continue;
				const objectIds = [...new Set([...a.ids, ...b.ids])].sort();
				if (Math.abs(angle - 90) < 1e-5) {
					rightAngleTurns++;
					if (config.rules?.forbidRightAngle)
						addViolation('forbidRightAngle', 'RIGHT_ANGLE', 'Right-angle copper junction', a.segment.net, objectIds, angle, 45, 'deg');
				}
				if (config.rules?.allowedTurnAnglesDeg && !config.rules.allowedTurnAnglesDeg.some((value) => Math.abs(value - angle) < 1e-4))
					addViolation(
						'allowedTurnAnglesDeg',
						'TURN_ANGLE',
						'Copper junction angle is not allowed',
						a.segment.net,
						objectIds,
						angle,
						undefined,
						'deg',
					);
			}
	for (const [index, segment] of segments.entries()) {
		const { a, b, radius, net, id } = segment;
		for (const outline of input[2] || [])
			for (let j = 0; j < outline.length; j++) {
				const clearance = geometry.segmentDistance(a, b, outline[j], outline[(j + 1) % outline.length]) - radius;
				if (clearance + 1e-5 < input[3])
					addViolation(
						'edgeCopperGapMil',
						'EDGE_CLEARANCE',
						'Copper violates the board-edge gap',
						net,
						[id, 'board-outline'],
						clearance / WORLD_PER_MIL,
						input[3] / WORLD_PER_MIL,
					);
			}
		if (
			input[2]?.length &&
			(!geometry.pointInPolygon(a, input[2][0]) ||
				!geometry.pointInPolygon(b, input[2][0]) ||
				input[2].slice(1).some((hole) => geometry.pointInPolygon(a, hole) || geometry.pointInPolygon(b, hole)))
		)
			addViolation('board-outline', 'OUTSIDE_BOARD', 'Copper lies outside the board or in a cutout', net, [id]);
		for (const region of constraints.keepouts) {
			if (region.kind === 'via' && !segment.via) continue;
			if (!region.layers.some((z) => z >= Math.min(a[2], b[2]) && z <= Math.max(a[2], b[2]))) continue;
			const clearance = geometry.polygonDistance(a, b, region.points) - radius;
			const required = Math.max(segment.gap, region.gap);
			if (clearance + 1e-5 < required || geometry.pointInPolygon(a, region.points) || geometry.pointInPolygon(b, region.points))
				addViolation(
					'keepouts',
					'KEEPOUT_CONFLICT',
					'Copper intersects a keepout',
					net,
					[id, region.id],
					clearance / WORLD_PER_MIL,
					required / WORLD_PER_MIL,
				);
		}
		for (let j = 0; j < index; j++) {
			const other = segments[j];
			if (
				other.net === net ||
				Math.max(Math.min(a[2], b[2]), Math.min(other.a[2], other.b[2])) > Math.min(Math.max(a[2], b[2]), Math.max(other.a[2], other.b[2]))
			)
				continue;
			const clearance = geometry.segmentDistance(a, b, other.a, other.b) - radius - other.radius;
			const required = Math.max(segment.gap, other.gap);
			if (clearance + 1e-5 < required)
				addViolation(
					'copperClearanceMil',
					'COPPER_CLEARANCE',
					'Different nets violate copper clearance',
					net,
					[id, other.id],
					clearance / WORLD_PER_MIL,
					required / WORLD_PER_MIL,
				);
		}
		for (const track of input[1]) {
			if (track[5] === net) continue;
			for (const [padIndex, pad] of track[3].entries()) {
				const layers = pad[4]?.length ? pad[4] : input[0][2] ? Array.from({ length: input[0][2] }, (_, z) => z) : [];
				for (const z of layers) {
					if (z < Math.min(a[2], b[2]) || z > Math.max(a[2], b[2])) continue;
					const clearance = geometry.padDistance(a, b, pad, z) - radius;
					const required = Math.max(segment.gap, pad[1]);
					if (clearance + 1e-5 < required)
						addViolation(
							'copperClearanceMil',
							'PAD_CLEARANCE',
							'Copper violates a different pad clearance',
							net,
							[id, 'pad:' + (track[5] || 'unassigned') + ':' + padIndex],
							clearance / WORLD_PER_MIL,
							required / WORLD_PER_MIL,
						);
				}
			}
		}
	}
	for (const check of ruleChecks) if (violations.some((item) => item.ruleId === check.ruleId)) check.status = 'failed';
	const requested = data[1].filter((track) => track[0] > 0 && !track[6]?.protected);
	const failed = requested.filter((track) => !netConnected(input[1].find((source) => source[5] === track[5]) || track, segments));
	return {
		coverage: {
			totalNets: requested.length,
			routedNets: requested.length - failed.length,
			failedNets: failed.map((track) => track[5]),
			totalPins: requested.reduce((sum, track) => sum + track[3].length, 0),
		},
		geometry: { tracks, vias: viaKeys.size, diagonalSegments, rightAngleTurns, nonOrthogonalPadExits: null },
		violations,
		ruleChecks,
	};
}
module.exports = { inspectResult };
