const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '../..');
const bundle = esbuild.buildSync({ entryPoints: [path.join(root, 'src/index.ts')], bundle: true, platform: 'node', format: 'cjs', write: false })
	.outputFiles[0].text;
const source = fs.readFileSync(path.join(root, 'tests/fixtures/three-pin.dsn'), 'utf8');

function app() {
	const calls = [],
		registry = new Map(),
		files = new Map();
	const pcb = { uuid: 'pcb-1', name: 'PCB 1', parentProjectUuid: 'project-1', parentBoardName: 'Board 1' };
	let document = { uuid: pcb.uuid, documentType: 3 };
	const host = {
		dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: 'project-1' }) },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => document },
		dmt_Pcb: { getCurrentPcbInfo: async () => pcb, getPcbInfo: async (uuid) => (uuid === pcb.uuid ? pcb : undefined) },
		dmt_Board: {
			getBoardInfo: async (name) => (name === pcb.parentBoardName ? { name, parentProjectUuid: pcb.parentProjectUuid, pcb } : undefined),
		},
		dmt_EditorControl: {
			openDocument: async (uuid) => {
				calls.push(['open', uuid]);
				return 'tab-1';
			},
			activateDocument: async (tab) => {
				calls.push(['activate', tab]);
				document = { uuid: pcb.uuid, documentType: 3 };
				return true;
			},
		},
		pcb_ManufactureData: {
			getDsnFile: async () => {
				calls.push(['dsn']);
				return { text: async () => source };
			},
		},
		sys_FileSystem: {
			saveFileToFileSystem: async (uri, blob) => {
				files.set(uri, await blob.text());
				return true;
			},
		},
		sys_ExternalApi: {
			register: (ns, name, fn) => {
				calls.push(['register', ns, name]);
				registry.set(ns + '.' + name, fn);
			},
		},
		sys_IFrame: {
			openIFrame() {
				throw new Error('Headless code opened an IFrame');
			},
		},
		pcb_Document: {
			importAutoRouteSesFile() {
				throw new Error('Headless code imported copper');
			},
			save() {
				throw new Error('Headless code saved the PCB');
			},
		},
	};
	const context = vm.createContext({ eda: host, EDMT_EditorDocumentType: { PCB: 3 }, Blob, module: { exports: {} }, console });
	vm.runInContext(bundle, context);
	return {
		api: context.module.exports,
		host,
		context,
		registry,
		files,
		calls,
		pcb,
		setDocument: (value) => {
			document = value;
		},
	};
}

test('startup registers an independent API before the IFrame is ever opened', async () => {
	const a = app();
	a.api.activate('onStartupFinished');
	a.api.activate('onStartupFinished');
	assert.equal(a.registry.size, 2);
	assert.equal(a.calls.filter((call) => call[0] === 'register').length, 2);
	const caps = a.registry.get('jspcb.getCapabilities')();
	assert.equal(caps.skillRequired, false);
	const report = await a.registry.get('jspcb.routeCurrentPcb')({ solver: { seed: 1 } });
	assert.equal(report.status, 'dry-run');
	assert.equal(report.pcbUuid, 'pcb-1');
	assert.equal(report.boardName, 'Board 1');
	assert.equal(report.projectUuid, 'project-1');
	assert.equal(report.imported, false);
	assert.equal(report.execution.saved, false);
	assert.ok(!a.calls.some((call) => call[0] === 'open'));
});

test('older clients retain ordinary routing exports when external registration is absent', () => {
	const a = app();
	delete a.host.sys_ExternalApi;
	a.api.activate('onStartupFinished');
	assert.equal(typeof a.api.startAutoRouteIFrame, 'function');
	assert.equal(a.registry.size, 0);
});

test('explicit target selection works from a schematic using the returned tab id', async () => {
	for (const target of [{ pcbUuid: 'pcb-1' }, { boardName: 'Board 1' }]) {
		const a = app();
		a.setDocument({ uuid: 'schematic-1', documentType: 1 });
		const report = await a.api.routeCurrentPcb({ target, solver: { seed: 1 } });
		assert.equal(report.status, 'dry-run');
		assert.deepEqual(a.calls.slice(0, 2), [
			['open', 'pcb-1'],
			['activate', 'tab-1'],
		]);
	}
});

test('non-PCB documents, missing projects and targets in another project fail closed', async () => {
	const schematic = app();
	schematic.setDocument({ uuid: 'schematic-1', documentType: 1 });
	assert.equal((await schematic.api.routeCurrentPcb()).violations[0].code, 'NOT_PCB');
	const missing = app();
	missing.host.dmt_Project.getCurrentProjectInfo = async () => undefined;
	assert.equal((await missing.api.routeCurrentPcb()).violations[0].code, 'NO_PROJECT');
	const other = app();
	other.host.dmt_Pcb.getPcbInfo = async () => ({ ...other.pcb, parentProjectUuid: 'other-project' });
	assert.equal((await other.api.routeCurrentPcb({ target: { pcbUuid: 'pcb-1' } })).violations[0].code, 'TARGET_NOT_FOUND');
	assert.equal(other.calls.length, 0);
});

test('target activation is verified instead of trusting a successful open call', async () => {
	const a = app();
	a.setDocument({ uuid: 'schematic-1', documentType: 1 });
	a.host.dmt_EditorControl.activateDocument = async () => true;
	const report = await a.api.routeCurrentPcb({ target: { pcbUuid: 'pcb-1' } });
	assert.equal(report.status, 'rejected');
	assert.ok(!a.calls.some((call) => call[0] === 'dsn'));
});

test('document switches during DSN export invalidate the request', async () => {
	const a = app();
	a.host.pcb_ManufactureData.getDsnFile = async () => {
		a.setDocument({ uuid: 'pcb-other', documentType: 3 });
		return { text: async () => source };
	};
	const report = await a.api.routeCurrentPcb();
	assert.equal(report.status, 'rejected');
	assert.equal(report.violations[0].code, 'DOCUMENT_CHANGED');
});

test('concurrent requests are rejected and the adapter becomes available after completion', async () => {
	const a = app();
	let release;
	a.host.pcb_ManufactureData.getDsnFile = () =>
		new Promise((resolve) => {
			release = resolve;
		});
	const first = a.api.routeCurrentPcb();
	while (!release) await new Promise((resolve) => setImmediate(resolve));
	assert.equal((await a.api.routeCurrentPcb()).violations[0].code, 'ROUTER_BUSY');
	release({ text: async () => source });
	assert.equal((await first).status, 'dry-run');
	a.host.pcb_ManufactureData.getDsnFile = async () => ({ text: async () => source });
	assert.equal((await a.api.routeCurrentPcb()).status, 'dry-run');
});

test('invalid rules and import mode never reach EDA APIs', async () => {
	for (const options of [
		{ mode: 'import' },
		{ rules: { padExit: { mode: 'orthogonal', leadMil: 8 } } },
		{ constraints: { preserveExistingRoutes: true } },
	]) {
		const a = app();
		const report = await a.api.routeCurrentPcb(options);
		assert.equal(report.status, 'rejected');
		assert.equal(a.calls.length, 0);
	}
});

test('requested SES and report artifacts are written without dialogs and false writes are errors', async () => {
	const a = app();
	const options = { output: { saveSesPath: '/project/result.ses', saveReportPath: '/project/result.json', includeSes: true } };
	const report = await a.api.routeCurrentPcb(options);
	assert.equal(report.status, 'dry-run');
	assert.ok(a.files.get('/project/result.ses').includes('(session'));
	const saved = JSON.parse(a.files.get('/project/result.json'));
	assert.equal(saved.imported, false);
	assert.equal(saved.artifacts.reportPath, '/project/result.json');
	assert.equal(report.artifacts.sesText, a.files.get('/project/result.ses'));
	const bad = app();
	bad.host.sys_FileSystem.saveFileToFileSystem = async () => false;
	const failed = await bad.api.routeCurrentPcb(options);
	assert.equal(failed.status, 'rejected');
	assert.equal(failed.violations.at(-1).code, 'OUTPUT_WRITE_FAILED');
	assert.equal(failed.artifacts.sesPath, undefined);
	assert.equal(failed.execution.phase, 'output');
	const throwing = app();
	throwing.host.sys_FileSystem.saveFileToFileSystem = async () => {
		throw new Error('Disk write failed');
	};
	const writeError = await throwing.api.routeCurrentPcb({ output: { saveReportPath: '/project/result.json' } });
	assert.equal(writeError.violations.at(-1).code, 'OUTPUT_WRITE_FAILED');
	assert.equal(writeError.artifacts?.reportPath, undefined);
});

test('the extension identity and startup activation remain stable', () => {
	const extension = JSON.parse(fs.readFileSync(path.join(root, 'extension.json'), 'utf8'));
	assert.equal(extension.uuid, 'fe81c92e8cae445f9e4e4117058555f5');
	assert.equal(extension.activationEvents.onStartupFinished, true);
});
