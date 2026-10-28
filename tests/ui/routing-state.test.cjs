const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function element(value = '') {
	return {
		value,
		checked: false,
		disabled: false,
		innerHTML: '',
		innerText: '',
		style: {},
		classList: { toggle() {} },
		setAttribute() {},
		addEventListener() {},
		checkValidity() {
			return true;
		},
		append() {},
		appendChild() {},
		remove() {},
	};
}
function candidate() {
	return {
		callbacks: {},
		terminated: false,
		addEventListener(type, callback) {
			this.callbacks[type] = callback;
		},
		postMessage(data) {
			this.input = data;
		},
		terminate() {
			this.terminated = true;
		},
		emit(data) {
			this.callbacks.message({ data });
		},
	};
}
async function runtime() {
	const elements = new Map();
	for (const id of [
		'history_list',
		'history_empty',
		'log-content',
		'timer-display',
		'go',
		'export_ses',
		'progress-fill',
		'progress-text',
		'auto_import',
		'files',
		'load_dsn_eda',
		'file_input_wrapper',
		'eda_input_group',
		'clear_history',
		'dsn_normalize',
	])
		elements.set(id, element());
	for (const [key, value] of Object.entries({ g: 2, c: 0, t: 3, v: 0, s: 1, z: 16, r: 1, q: 2, d: 1, fr: 2, xr: 1, yr: 1 }))
		elements.set('arg_' + key, element(String(value)));
	const imports = [];
	const app = { elements, imports };
	const sample = [
		[30, 30, 2],
		[
			[
				1,
				2,
				1,
				[],
				[
					[
						[5, 5, 0],
						[20, 20, 0],
					],
				],
			],
		],
	];
	const context = vm.createContext({
		console,
		setInterval: () => 1,
		clearInterval() {},
		window: { addEventListener() {} },
		document: {
			getElementById: (id) => elements.get(id),
			querySelectorAll: () => [],
			addEventListener() {},
			createElement: () => element(),
			body: element(),
		},
		localStorage: { getItem: () => null, setItem() {} },
		jspcbI18n: { ready: Promise.resolve(), getLang: () => 'en', t: (key) => key },
		jspcbUi: { formatLog: (message) => message, cancelImportConfirmation() {}, confirmImport: async () => true },
		js_pcb: { dsn2pcb: () => structuredClone(sample), view_pcb() {} },
		parseDsnInfo: (source) => ({ source }),
		convertPcbToSes: (data, info, options) => {
			app.exported = { data, info, options };
			return '(session "test")';
		},
		File: class {
			constructor(parts, name) {
				this.parts = parts;
				this.name = name;
			}
		},
		eda: { pcb_Document: { importAutoRouteSesFile: async (file) => imports.push(file) } },
	});
	app.context = context;
	vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../iframe/jspcb/main.js'), 'utf8'), context);
	await context.jspcbI18n.ready;
	await Promise.resolve();
	vm.runInContext('file="normalized-one"; originalFile="original-one"; fileName="board-one";', context);
	return app;
}

function result(unrouted = 0) {
	return {
		type: 'done',
		data: [
			[30, 30, 2],
			[
				[
					1,
					2,
					1,
					[],
					[
						[
							[5, 5, 0],
							[20, 20, 0],
						],
					],
				],
			],
		],
		total: 2,
		unrouted,
		status: unrouted ? 'partial' : 'complete',
	};
}

test('a rejected stale worker creation cannot stop the replacement run', async () => {
	const app = await runtime();
	let rejectOld;
	const old = new Promise((resolve, reject) => {
		rejectOld = reject;
	});
	const next = candidate();
	let calls = 0;
	app.context.createRoutingWorker = () => (++calls === 1 ? old : Promise.resolve(next));
	const first = app.context.handleOnGo();
	app.context.stopRouting();
	await app.context.handleOnGo();
	rejectOld(new Error('Old creation failed'));
	await first;
	assert.equal(vm.runInContext('isRouting', app.context), true);
	assert.equal(next.terminated, false);
	assert.equal(app.elements.get('go').innerText, 'ui.stop');
});

test('a stale worker that finishes creating is disposed without replacing the active worker', async () => {
	const app = await runtime();
	let resolveOld;
	const old = new Promise((resolve) => {
		resolveOld = resolve;
	});
	const previous = candidate(),
		next = candidate();
	let calls = 0;
	app.context.createRoutingWorker = () => (++calls === 1 ? old : Promise.resolve(next));
	const first = app.context.handleOnGo();
	app.context.stopRouting();
	await app.context.handleOnGo();
	resolveOld(previous);
	await first;
	assert.equal(previous.terminated, true);
	assert.equal(next.terminated, false);
	assert.equal(vm.runInContext('worker', app.context), next);
});

test('a late confirmation cannot import a newer run or change its state', async () => {
	const app = await runtime();
	const firstWorker = candidate(),
		secondWorker = candidate();
	const workers = [firstWorker, secondWorker];
	app.context.createRoutingWorker = async () => workers.shift();
	await app.context.handleOnGo();
	firstWorker.emit(result(1));
	let accept;
	app.context.jspcbUi.confirmImport = () =>
		new Promise((resolve) => {
			accept = resolve;
		});
	const pending = app.context.importResultToPcb(vm.runInContext('lastResult', app.context));
	await app.context.handleOnGo();
	accept(true);
	await pending;
	assert.equal(app.imports.length, 0);
	assert.equal(vm.runInContext('isRouting', app.context), true);
});

test('manual export uses the original result parameters and automatic import is opt-in', async () => {
	const app = await runtime();
	const running = candidate();
	app.context.createRoutingWorker = async () => running;
	await app.context.handleOnGo();
	running.emit(result());
	assert.equal(app.imports.length, 0);
	app.elements.get('arg_g').value = '5';
	vm.runInContext('originalFile="different-file"; fileName="different-name";', app.context);
	await app.context.importResultToPcb(vm.runInContext('lastResult', app.context));
	assert.equal(app.imports.length, 1);
	assert.equal(app.imports[0].name, 'board-one.ses');
	assert.equal(app.exported.info.source, 'original-one');
	assert.equal(app.exported.options.gap, 2);
});

test('enabled automatic import still asks before importing partial results', async () => {
	const app = await runtime();
	app.elements.get('auto_import').checked = true;
	const running = candidate();
	app.context.createRoutingWorker = async () => running;
	let prompts = 0;
	app.context.jspcbUi.confirmImport = async () => {
		prompts++;
		return false;
	};
	await app.context.handleOnGo();
	running.emit(result(1));
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(prompts, 1);
	assert.equal(app.imports.length, 0);
});
