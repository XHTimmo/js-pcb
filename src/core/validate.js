'use strict';
const { RouteError } = require('./options.js');
const { WORLD_PER_MIL } = require('./constraints.js');

function validateParsedPcb(pcb) {
	function finite(value) {
		if (typeof value === 'number' && !Number.isFinite(value)) throw new RouteError('INVALID_DSN', 'DSN contains nonfinite geometry');
		if (Array.isArray(value)) value.forEach(finite);
		else if (value && typeof value === 'object') Object.values(value).forEach(finite);
	}
	finite(pcb);
	for (const track of pcb[1]) {
		if (track.slice(0, 3).some((n) => n < 0) || (track[5] && (track[0] <= 0 || track[1] <= 0)))
			throw new RouteError('INVALID_DSN', 'DSN has invalid track/via width or clearance');
		for (const pad of track[3])
			if (pad[0] < 0 || pad[1] < 0 || Object.values(pad[5] || {}).some((shape) => shape.r < 0))
				throw new RouteError('INVALID_DSN', 'DSN has invalid pad geometry');
	}
	if (pcb[3] < 0) throw new RouteError('INVALID_DSN', 'DSN has negative board-edge clearance');
}

// The existing SES writer emits one circular through-via type. Reject results
// outside that model rather than reporting clearance for a different footprint.
function assertSesViaModel(tree, pcb, info, viaCount) {
	if (!viaCount) return;
	const reject = () => {
		throw new RouteError('UNSUPPORTED_VIA_MODEL', 'SES output currently supports one uniform circular through-via on two copper layers');
	};
	if (pcb[0][2] !== 2 || pcb[1].some((track) => track[0] > 0 && Math.abs((track[1] * 2) / WORLD_PER_MIL - info.viaSize) > 1e-5)) reject();
	const library = tree.find((node) => Array.isArray(node) && node[0] === 'library');
	const definition = library?.find(
		(node) => Array.isArray(node) && node[0] === 'padstack' && String(node[1]).replace(/^"|"$/g, '') === info.viaName,
	);
	const shapes = definition?.filter((node) => Array.isArray(node) && node[0] === 'shape').map((node) => node[1]) || [];
	if (
		shapes.length !== 2 ||
		shapes.some(
			(shape) =>
				!Array.isArray(shape) ||
				shape[0] !== 'circle' ||
				Number(shape[2]) !== info.viaSize ||
				(shape[3] !== undefined && Number(shape[3]) !== 0) ||
				(shape[4] !== undefined && Number(shape[4]) !== 0),
		)
	)
		reject();
}
module.exports = { validateParsedPcb, assertSesViaModel };
