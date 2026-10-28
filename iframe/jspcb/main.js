/**
 * Integrates PR #3 with the interface and attribution retained from PR #2.
 * Original contribution: summving <summving@easyeda.com> (@easyeda2021).
 * https://github.com/XHTimmo/js-pcb/pull/3 — see NOTICE.md.
 */
let file = null;
let originalFile = null;
let fileName = 'output';
let isDsnNormalized = false;
let worker = null;
let currentBoundary = null;
let lastPcbData = null;
let lastResult = null;
let currentTask = null;
let routingGeneration = 0;
let isRouting = false;
let isImporting = false;
let routingTimer = null;
const HISTORY_KEY = 'js_pcb_history_v1';
const HISTORY_LIMIT = 10;
let historyRecords = loadHistory();
let logRecords = [];
let progressState = { done: 0, total: 0, completed: false };

function t(key, ...args) {
	return jspcbI18n.t(key, ...args);
}

function startTimer() {
	stopTimer();
	const display = document.getElementById('timer-display');
	const start = Date.now();
	display.style.display = 'block';
	display.innerText = '00:00';
	routingTimer = setInterval(function () {
		const seconds = Math.floor((Date.now() - start) / 1000);
		display.innerText = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
	}, 1000);
}

function stopTimer() {
	if (routingTimer !== null) clearInterval(routingTimer);
	routingTimer = null;
}

function loadHistory() {
	try {
		const records = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
		return Array.isArray(records) ? records.slice(0, HISTORY_LIMIT) : [];
	} catch (error) {
		return [];
	}
}

function renderHistory() {
	const list = document.getElementById('history_list');
	list.innerHTML = '';
	document.getElementById('history_empty').style.display = historyRecords.length ? 'none' : 'block';
	for (const record of historyRecords) {
		const item = document.createElement('div');
		item.className = 'history-item';
		const title = document.createElement('div');
		title.className = 'history-title';
		const name = document.createElement('span');
		name.innerText = record.fileName || 'output';
		const time = document.createElement('span');
		time.innerText = new Date(record.createdAt).toLocaleString(jspcbI18n.getLang());
		title.append(name, time);
		const meta = document.createElement('div');
		meta.className = 'history-meta';
		const params = record.params || {};
		meta.innerText = `S${params.s ?? ''} R${params.r ?? ''} Z${params.z ?? ''} ` + t('ui.historyGap', params.g ?? '');
		const actions = document.createElement('div');
		actions.className = 'history-actions';
		const button = document.createElement('button');
		button.type = 'button';
		button.innerText = t('ui.downloadSes');
		button.onclick = function () {
			const stamp = new Date(record.createdAt).toISOString().replace(/[:.]/g, '-');
			downloadSes(record.sesContent, (record.fileName || 'output') + '_' + stamp + '.ses');
		};
		actions.appendChild(button);
		item.append(title, meta, actions);
		list.appendChild(item);
	}
}

function persistHistory() {
	localStorage.setItem(HISTORY_KEY, JSON.stringify(historyRecords));
}

function sesForResult(result) {
	const info = parseDsnInfo(result.originalFile);
	info.fileName = result.fileName;
	info.isDsnNormalized = result.isDsnNormalized;
	return convertPcbToSes(result.data, info, { gap: result.params.g });
}

function addHistoryRecord(result) {
	try {
		const timestamp = Date.now();
		historyRecords.unshift({
			id: String(timestamp),
			fileName: result.fileName,
			createdAt: timestamp,
			params: result.params,
			status: result.status,
			sesContent: sesForResult(result),
		});
		historyRecords = historyRecords.slice(0, HISTORY_LIMIT);
		persistHistory();
		renderHistory();
	} catch (error) {
		appendLog('log.historyFail', error.message);
	}
}

function downloadSes(content, name) {
	if (!content) return;
	const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

function getCurrentParams() {
	return Object.fromEntries(
		['g', 'c', 't', 'v', 's', 'z', 'r', 'q', 'd', 'fr', 'xr', 'yr'].map(function (key) {
			const input = document.getElementById('arg_' + key);
			if (!input.checkValidity()) throw new Error(t('error.parameter', key));
			return [key, Number(input.value)];
		}),
	);
}

function updateControls() {
	const go = document.getElementById('go');
	const key = isRouting ? 'ui.stop' : 'ui.start';
	go.setAttribute('data-i18n', key);
	go.innerText = t(key);
	go.classList.toggle('stop-mode', isRouting);
	go.disabled = isImporting;
	document.getElementById('export_ses').disabled = isRouting || isImporting || !lastResult;
	for (const element of document.querySelectorAll('.param-row input, .step-btn, #auto_import, #files, #load_dsn_eda')) {
		element.disabled = isRouting || isImporting;
	}
}

function setProgress(done, total, completed = false) {
	progressState = { done: done, total: total, completed: completed };
	const percent = completed ? 100 : total ? Math.min(100, Math.round((done / total) * 100)) : 0;
	document.getElementById('progress-fill').style.width = percent + '%';
	document.getElementById('progress-text').innerText = completed ? t('ui.progressDone', done, total) : t('ui.progress', done, total, percent);
}

function renderLogRecord(record) {
	const container = document.getElementById('log-content');
	const entry = document.createElement('div');
	entry.className = 'log-entry';
	const timestamp = new Date(record.time).toLocaleTimeString(jspcbI18n.getLang(), { hour12: false });
	entry.innerText = '[' + timestamp + '] ' + jspcbUi.formatLog(record.message, record.args);
	container.appendChild(entry);
	container.scrollTop = container.scrollHeight;
}

function renderLogs() {
	document.getElementById('log-content').innerHTML = '';
	logRecords.forEach(renderLogRecord);
}

function appendLog(message, ...args) {
	const record = { message: message, args: args, time: Date.now() };
	logRecords.push(record);
	renderLogRecord(record);
}

async function loadTextFile(relativePath) {
	if (typeof eda !== 'undefined' && eda?.sys_FileSystem?.getExtensionFile) {
		const extensionFile = await eda.sys_FileSystem.getExtensionFile('/iframe/jspcb/' + relativePath);
		if (extensionFile) return await extensionFile.text();
	}
	const response = await fetch('/iframe/jspcb/' + relativePath);
	if (!response.ok) throw new Error('Cannot load ' + relativePath);
	return await response.text();
}

async function createRoutingWorker() {
	try {
		return new Worker('/iframe/jspcb/worker.js');
	} catch (error) {
		/* Use a Blob in restricted iframe environments. */
	}
	const sources = await Promise.all(['mymath.js', 'layer.js', 'router.js', 'worker.js'].map(loadTextFile));
	sources[3] = sources[3].replace(/^\s*importScripts\([^)]*\);\s*/m, '');
	const url = URL.createObjectURL(new Blob([sources.join('\n')], { type: 'application/javascript' }));
	try {
		const candidate = new Worker(url);
		candidate.jspcbBlobUrl = url;
		return candidate;
	} catch (error) {
		URL.revokeObjectURL(url);
		throw error;
	}
}

function releaseWorker(candidate) {
	if (!candidate) return;
	candidate.terminate();
	if (candidate.jspcbBlobUrl) URL.revokeObjectURL(candidate.jspcbBlobUrl);
	if (worker === candidate) worker = null;
}

function invalidateTask() {
	routingGeneration++;
	jspcbUi.cancelImportConfirmation();
	releaseWorker(worker);
	currentTask = null;
	isRouting = false;
	stopTimer();
}

function stopRouting() {
	invalidateTask();
	updateControls();
	appendLog('log.stopped');
}

function finishTask(task) {
	if (task.generation !== routingGeneration) return;
	isRouting = false;
	stopTimer();
	releaseWorker(worker);
	updateControls();
}

async function handleOnGo() {
	if (isImporting) return;
	if (isRouting) {
		stopRouting();
		return;
	}
	if (!file) return;
	invalidateTask();
	const task = { generation: routingGeneration, originalFile: originalFile, fileName: fileName, isDsnNormalized: isDsnNormalized };
	currentTask = task;
	lastResult = null;
	logRecords = [];
	renderLogs();
	appendLog('log.init');
	try {
		task.params = getCurrentParams();
		isRouting = true;
		updateControls();
		startTimer();
		task.autoImport = document.getElementById('auto_import').checked;
		const p = task.params;
		const pcb = js_pcb.dsn2pcb(file, p.g, p.c);
		currentBoundary = pcb[2] || null;
		setProgress(0, pcb[1].filter((track) => track[0] > 0).length);
		const candidate = await createRoutingWorker();
		if (task.generation !== routingGeneration) {
			releaseWorker(candidate);
			return;
		}
		worker = candidate;
		candidate.addEventListener('message', function (event) {
			if (task.generation !== routingGeneration) return;
			const message = event.data;
			if (message.type === 'log') {
				appendLog(message.key || message.message, ...(message.args || []));
				return;
			}
			if (message.type === 'progress') {
				setProgress(message.done, message.total);
				return;
			}
			if (message.type === 'error') {
				appendLog('log.routeError', message.message);
				finishTask(task);
				return;
			}
			if (message.type === 'done') {
				lastPcbData = message.data;
				lastResult = { ...task, data: message.data, total: message.total, unrouted: message.unrouted, status: message.status };
				js_pcb.view_pcb(lastPcbData, 0, 2, currentBoundary);
				setProgress(message.total - message.unrouted, message.total, true);
				addHistoryRecord(lastResult);
				finishTask(task);
				if (task.autoImport) importResultToPcb(lastResult);
				return;
			}
			const preview = Array.isArray(message) ? message : message.data;
			if (Array.isArray(preview)) {
				lastPcbData = preview;
				js_pcb.view_pcb(preview, 0, 2, currentBoundary);
			}
		});
		candidate.addEventListener('error', function (event) {
			if (task.generation !== routingGeneration) return;
			appendLog('log.workerRuntime', event.message || '');
			finishTask(task);
		});
		candidate.postMessage([pcb, p.t, p.v, p.s, p.z, p.r, p.q, p.d, p.fr, p.xr, p.yr]);
	} catch (error) {
		// A rejected old creation must never stop or reset the replacement task.
		if (task.generation !== routingGeneration) return;
		appendLog('log.routeError', error.message || String(error));
		finishTask(task);
	}
}

async function importResultToPcb(result) {
	if (!result || isImporting || isRouting) return;
	if (!result.data[1].some((track) => track[4]?.length)) {
		appendLog('log.noTracks');
		return;
	}
	const generation = routingGeneration;
	if (result.unrouted > 0 || result.status === 'timeout') {
		const accepted = await jspcbUi.confirmImport(result.total - result.unrouted, result.total);
		// Capture the exact result and reject stale dialogs after a new run/file.
		if (!accepted || generation !== routingGeneration || result !== lastResult || isRouting) return;
	}
	if (generation !== routingGeneration || result !== lastResult || isImporting) return;
	isImporting = true;
	updateControls();
	try {
		const content = sesForResult(result);
		const name = result.fileName + '.ses';
		if (typeof eda !== 'undefined' && eda?.pcb_Document?.importAutoRouteSesFile) {
			const sesFile = new File([content], name, { type: 'text/plain' });
			try {
				await eda.pcb_Document.importAutoRouteSesFile(sesFile);
				appendLog(result.unrouted ? 'log.partialImport' : 'log.imported');
			} catch (error) {
				appendLog('log.importFail', error.message || String(error));
				if (eda?.sys_FileSystem?.saveFile) await eda.sys_FileSystem.saveFile(sesFile, name);
				else downloadSes(content, name);
			}
		} else {
			downloadSes(content, name);
			appendLog('log.exported');
		}
	} catch (error) {
		appendLog('log.sesFail', error.message || String(error));
	} finally {
		isImporting = false;
		updateControls();
	}
}

function handleOnLoad(event) {
	invalidateTask();
	originalFile = event.target.result;
	lastPcbData = null;
	lastResult = null;
	currentBoundary = null;
	isDsnNormalized = false;
	try {
		const normalize = document.getElementById('dsn_normalize').checked && /\(resolution\s+mil\s+1000\)/i.test(originalFile);
		file = normalize ? normalizeDsn(originalFile) : originalFile;
		isDsnNormalized = normalize;
		renderBoardPreview();
		updateControls();
		return true;
	} catch (error) {
		file = null;
		updateControls();
		appendLog('log.normFail', error.message || String(error));
		return false;
	}
}

function renderBoardPreview() {
	if (!file || isRouting) return;
	try {
		const params = getCurrentParams();
		const pcb = js_pcb.dsn2pcb(file, params.g, params.c);
		currentBoundary = pcb[2] || null;
		lastPcbData = pcb;
		js_pcb.view_pcb(pcb, 0, 2, currentBoundary);
		setProgress(0, pcb[1].filter((track) => track[0] > 0).length);
	} catch (error) {
		appendLog('log.dsnParseFail', error.message || String(error));
	}
}

let dsnLoadGeneration = 0;
async function tryLoadDsnFromEda() {
	if (typeof eda === 'undefined' || !eda?.pcb_ManufactureData?.getDsnFile || isRouting || isImporting) return;
	const request = ++dsnLoadGeneration;
	document.getElementById('load_dsn_eda').disabled = true;
	try {
		const dsn = await eda.pcb_ManufactureData.getDsnFile();
		const content = typeof dsn === 'string' ? dsn : await dsn.text();
		if (request !== dsnLoadGeneration || isRouting || isImporting) return;
		document.getElementById('dsn_normalize').checked = true;
		fileName = parseDsnInfo(content).fileName || 'output';
		handleOnLoad({ target: { result: content } });
	} catch (error) {
		if (request === dsnLoadGeneration) appendLog('log.dsnParseFail', error.message || String(error));
	} finally {
		if (request === dsnLoadGeneration) updateControls();
	}
}

function handleFileSelect(event) {
	const selected = event.target.files[0];
	if (!selected || !/\.dsn$/i.test(selected.name) || isRouting || isImporting) return;
	const request = ++dsnLoadGeneration;
	const reader = new FileReader();
	reader.onload = function (loaded) {
		if (request !== dsnLoadGeneration || isRouting || isImporting) return;
		fileName = selected.name.replace(/\.dsn$/i, '');
		handleOnLoad(loaded);
	};
	reader.readAsText(selected);
}

window.addEventListener('resize', function () {
	if (lastPcbData) js_pcb.view_pcb(lastPcbData, 0, 2, currentBoundary);
});
window.addEventListener('beforeunload', invalidateTask);
document.getElementById('files').addEventListener('change', handleFileSelect);
document.getElementById('go').onclick = handleOnGo;
document.getElementById('export_ses').onclick = function () {
	importResultToPcb(lastResult);
};
document.getElementById('load_dsn_eda').onclick = tryLoadDsnFromEda;
document.getElementById('clear_history').onclick = function () {
	historyRecords = [];
	persistHistory();
	renderHistory();
};
document.getElementById('arg_g').addEventListener('change', renderBoardPreview);
document.getElementById('arg_c').addEventListener('change', renderBoardPreview);
document.addEventListener('jspcb-lang-change', function () {
	renderHistory();
	renderLogs();
	updateControls();
	setProgress(progressState.done, progressState.total, progressState.completed);
});

jspcbI18n.ready.then(function () {
	renderHistory();
	updateControls();
	setProgress(0, 0);
	const isEda = typeof eda !== 'undefined' && !!eda?.pcb_ManufactureData?.getDsnFile;
	document.getElementById('file_input_wrapper').style.display = isEda ? 'none' : 'block';
	document.getElementById('eda_input_group').style.display = isEda ? 'flex' : 'none';
	const button = document.getElementById('export_ses');
	button.setAttribute('data-i18n', isEda ? 'ui.importSes' : 'ui.exportSes');
	button.innerText = t(isEda ? 'ui.importSes' : 'ui.exportSes');
	if (isEda) tryLoadDsnFromEda();
});
