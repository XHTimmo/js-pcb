const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');
const coreBundle = require('esbuild').buildSync({
	entryPoints: [path.join(root, 'src/core/index.js')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false,
}).outputFiles[0].text;

function runtime() {
	const messages = [];
	const context = vm.createContext({ module: { exports: {} }, console: { log() {}, warn() {}, error() {} } });
	vm.runInContext(coreBundle, context);
	const core = context.module.exports;
	context.js_pcb = core.engine;
	context.normalizeDsn = core.normalizeDsn;
	context.parseDsnInfo = core.parseDsnInfo;
	context.convertPcbToSes = core.convertPcbToSes;
	context.pcb_thread = (args) => core.solveLegacyParameters(args, { onEvent: (data) => messages.push(structuredClone(data)) });
	return { context, messages };
}

function fixture(name) {
	return fs.readFileSync(path.join(root, 'tests/fixtures', name + '.dsn'), 'utf8');
}
function run(app, pcb, samples = 1) {
	app.context.args = [pcb, 3, 0, samples, 16, 1, 2, 1, 2, 1, 1];
	vm.runInContext('pcb_thread(args)', app.context, { timeout: 5000 });
	const done = app.messages.findLast((message) => message.type === 'done');
	assert.ok(done, 'The worker must return a done result');
	return done;
}

// Build an independent graph of paths and pad contacts, including through-hole layer connections.
function assertConnected(track) {
	const paths = track[4];
	const parent = paths.map((_, i) => i);
	const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
	const union = (a, b) => {
		parent[find(a)] = find(b);
	};
	const near = (a, b) => a[2] === b[2] && Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.8;
	function onSegment(v, a, b) {
		if (v[2] !== a[2] || v[2] !== b[2]) return false;
		const dx = b[0] - a[0],
			dy = b[1] - a[1];
		const ratio = Math.max(0, Math.min(1, ((v[0] - a[0]) * dx + (v[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
		return Math.hypot(v[0] - a[0] - ratio * dx, v[1] - a[1] - ratio * dy) < 0.8;
	}
	function touches(v, p) {
		return p.some((q) => near(v, q)) || p.some((q, k) => k && onSegment(v, p[k - 1], q));
	}
	for (let i = 0; i < paths.length; i++)
		for (let j = i + 1; j < paths.length; j++) {
			if (paths[i].some((v) => touches(v, paths[j])) || paths[j].some((v) => touches(v, paths[i]))) union(i, j);
		}
	for (const terminal of track[3]) {
		const hits = paths.flatMap((p, i) => (terminal[4].some((z) => touches([terminal[2][0], terminal[2][1], z], p)) ? [i] : []));
		assert.ok(hits.length, 'Every terminal must touch copper on one of its actual layers');
		for (const hit of hits) union(hits[0], hit);
	}
	assert.equal(new Set(paths.map((_, i) => find(i))).size, 1, 'All paths must form one connected net');
}

for (const name of ['three-pin', 'layers-and-slot', 'opposite-smd']) {
	test('DSN → router → SES preserves connectivity and coordinates: ' + name, () => {
		const app = runtime();
		const source = fixture(name);
		const pcb = app.context.js_pcb.dsn2pcb(app.context.normalizeDsn(source), 2, 0);
		assert.equal(pcb[1][0][3].length, name === 'opposite-smd' ? 2 : 3);
		assert.equal(pcb[2].length, name === 'layers-and-slot' ? 2 : 1);
		const done = run(app, pcb);
		assert.equal(done.status, 'complete');
		assert.equal(done.unrouted, 0);
		assert.equal(done.total, 1);
		const routedTrack = done.data[1].find((track) => track[0] > 0);
		assertConnected(routedTrack);
		const info = app.context.parseDsnInfo(source);
		info.isDsnNormalized = true;
		const ses = app.context.convertPcbToSes(done.data, info, { gap: 2 });
		assert.equal((ses.match(/\(padstack via0/g) || []).length, 1);
		assert.ok(ses.includes('(net GND'));
		assert.ok(!ses.includes('Unmatched-'));
		assert.ok(ses.includes('(resolution mil 1000)'));
		if (name === 'opposite-smd') {
			assert.ok(ses.includes('(via via0'), 'Opposite-layer SMD pads require a via');
			assert.ok(ses.includes('(circle 1 20000'), 'Use the original 20 mil via size');
		}
		// The routed endpoints must recover the original DSN pin positions, in mil*1000.
		for (const term of routedTrack[3]) {
			const x = Math.round((((term[2][0] - 2) * 1000) / 254) * 1000);
			const y = Math.round(120000 - (((term[2][1] - 2) * 1000) / 254) * 1000);
			assert.ok([...info.pinPositions.values()].some((p) => Math.abs(p.x * 1000 - x) < 2 && Math.abs(p.y * 1000 - y) < 2));
		}
	});
}

test('a partially routed board reports both the good and unknown-layer nets', () => {
	const app = runtime();
	const pcb = app.context.js_pcb.dsn2pcb(app.context.normalizeDsn(fixture('partial')), 2, 0);
	const done = run(app, pcb);
	assert.equal(done.status, 'partial');
	assert.equal(done.total, 2);
	assert.equal(done.unrouted, 1);
	assert.equal(done.data[1].filter((track) => track[0] > 0 && track[4].length).length, 1);
});

test('unknown pad layers remain unrouted rather than connecting across copper layers', () => {
	const app = runtime();
	const pcb = app.context.js_pcb.dsn2pcb(app.context.normalizeDsn(fixture('three-pin')), 2, 0);
	pcb[1][0][3][0][4] = [];
	const done = run(app, pcb);
	assert.equal(done.status, 'partial');
	assert.equal(done.unrouted, 1);
	assert.ok(app.messages.some((message) => message.key === 'log.padLayerMissing'));
});

test('layer-specific pad geometry survives parsing and drives different collision bounds', () => {
	const app = runtime();
	const pcb = app.context.js_pcb.dsn2pcb(app.context.normalizeDsn(fixture('layers-and-slot')), 2, 0);
	const terminal = pcb[1][0][3][2];
	assert.ok(terminal[5][0].r > 0);
	assert.equal(terminal[5][1].r, 0);
	assert.equal(terminal[5][1].points.length, 5);
	app.context.pad = terminal;
	const collision = vm.runInContext(
		`(() => {
	 const p=new js_pcb.Pcb([40,40,2],[[],[]],[[],[]],js_pcb.manhattan_distance_3d,1,0,2,16);
	 p.add_track([1,2,0,[pad],[]]);
	 const [x,y]=pad[2];
	 return [0,1].map(z=>p.m_layers.hit_line([x+2.7,y,z],[x+2.7,y,z],0,0));
	})()`,
		app.context,
	);
	assert.equal(collision[0], false);
	assert.equal(collision[1], true);
});

test('node keys are unique in bounds and cannot alias out-of-range coordinates', () => {
	const app = runtime();
	const keys = vm.runInContext(
		`(() => {
	 const p=new js_pcb.Pcb([16,20,2],[[],[]],[[],[]],js_pcb.manhattan_distance_3d,1,0,2,16);
	 const keys=[];
	 for(let z=0;z<2;z++) for(let y=0;y<20;y++) for(let x=0;x<16;x++) keys.push(p.m_node_key([x,y,z]));
	 keys.push(p.m_node_key([16,0,0]),p.m_node_key([0,20,0]),p.m_node_key([0,0,2]),p.m_node_key([0.5,0,0]));
	 return keys;
	})()`,
		app.context,
	);
	assert.equal(new Set(keys).size, 16 * 20 * 2 + 4);
});

test('expired deadlines abort an inner flood search', () => {
	const app = runtime();
	const result = vm.runInContext(
		`(() => {
	 const p=new js_pcb.Pcb([16,20,2],[[],[]],[[],[]],js_pcb.manhattan_distance_3d,1,0,2,16);
	 p.m_deadline=Date.now()-1;
	 return p.mark_distances([[],[]],1,2,1,[[1,1,0]],[[14,18,1]]);
	})()`,
		app.context,
	);
	assert.equal(result, false);
});

test('final statistics describe the best sample instead of the last sample', () => {
	const app = runtime();
	vm.runInContext(
		`js_pcb.Pcb=class {
	 constructor(){this.sample=0;}
	 add_track(){} add_wall(){}
	 connected_nets(){return 1;}
	 unrouted_nets(){return this.sample===1?0:1;}
	 route(){this.sample++;return true;}
	 cost(){return this.sample===1?10:1e9;}
	 output_pcb(){return [[20,20,2],[[1,2,1,[],this.sample===1?[[[1,1,0],[10,10,0]]]:[]]]];}
	};`,
		app.context,
	);
	const done = run(app, [[20, 20, 2], []], 2);
	assert.equal(done.cost, 10);
	assert.equal(done.status, 'complete');
	assert.equal(done.unrouted, 0);
	assert.ok(done.data[1][0][4].length);
});
