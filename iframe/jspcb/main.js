/**
 * Presentation adapted from PR #1 by summving (@easyeda2021).
 * https://github.com/XHTimmo/js-pcb/pull/1 — see NOTICE.md.
 */
//filename and worker
let file = null;
let originalFile = null; // 保存原始文件内容（转换前）
let fileName = 'output'; // 文件名
let worker = null;
let lastPcbData = null; // 保存最后的布线结果
let isJlcConverted = false; // 是否经过 JLC 转换
let shouldSaveHistory = false;
let routingTimer = null;
let routingStartTime = 0;
const HISTORY_KEY = 'js_pcb_history_v1';
const HISTORY_LIMIT = 10;
let historyRecords = [];
let logRecords = [];

function t(key, ...args) {
	return jspcbI18n.t(key, ...args);
}

function startTimer() {
	stopTimer();
	const display = document.getElementById('timer-display');
	display.style.display = 'block';
	display.innerText = '00:00';
	routingStartTime = Date.now();

	routingTimer = setInterval(() => {
		const elapsed = Date.now() - routingStartTime;
		const seconds = Math.floor(elapsed / 1000);
		const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
		const ss = String(seconds % 60).padStart(2, '0');
		display.innerText = `${mm}:${ss}`;
	}, 1000);
}

function stopTimer() {
	if (routingTimer) {
		clearInterval(routingTimer);
		routingTimer = null;
	}
}

function loadHistory() {
	try {
		const raw = localStorage.getItem(HISTORY_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed;
	} catch (err) {
		return [];
	}
}

function persistHistory() {
	localStorage.setItem(HISTORY_KEY, JSON.stringify(historyRecords));
}

function formatTime(ts) {
	try {
		return new Date(ts).toLocaleString(jspcbI18n.getLang());
	} catch (err) {
		return '';
	}
}

function formatFileTimestamp(ts) {
	try {
		return new Date(ts).toISOString().replace(/[:.]/g, '-');
	} catch (err) {
		return String(ts);
	}
}

function getCurrentParams() {
	return {
		g: +document.getElementById('arg_g').value,
		t: +document.getElementById('arg_t').value,
		v: +document.getElementById('arg_v').value,
		s: +document.getElementById('arg_s').value,
		z: +document.getElementById('arg_z').value,
		r: +document.getElementById('arg_r').value,
		q: +document.getElementById('arg_q').value,
		d: +document.getElementById('arg_d').value,
		fr: +document.getElementById('arg_fr').value,
		xr: +document.getElementById('arg_xr').value,
		yr: +document.getElementById('arg_yr').value,
	};
}

function formatParams(params) {
	if (!params) return '';
	return `S${params.s} R${params.r} Z${params.z} D${params.d} Q${params.q} FR${params.fr} XR${params.xr} YR${params.yr}`;
}

function renderHistory() {
	const list = document.getElementById('history_list');
	const empty = document.getElementById('history_empty');
	list.innerHTML = '';
	if (!historyRecords.length) {
		empty.style.display = 'block';
		return;
	}
	empty.style.display = 'none';
	for (const record of historyRecords) {
		list.appendChild(createHistoryItem(record));
	}
}

function createHistoryItem(record) {
	const item = document.createElement('div');
	item.className = 'history-item';

	const title = document.createElement('div');
	title.className = 'history-title';
	const name = document.createElement('span');
	name.innerText = record.fileName || 'output';
	const time = document.createElement('span');
	time.innerText = formatTime(record.createdAt);
	title.appendChild(name);
	title.appendChild(time);

	const meta = document.createElement('div');
	meta.className = 'history-meta';
	const params = document.createElement('span');
	params.innerText = formatParams(record.params);
	const gap = document.createElement('span');
	gap.innerText = t('ui.historyGap', record.params ? record.params.g : '');
	meta.appendChild(params);
	meta.appendChild(gap);

	const actions = document.createElement('div');
	actions.className = 'history-actions';
	const downloadBtn = document.createElement('button');
	downloadBtn.type = 'button';
	downloadBtn.innerText = t('ui.downloadSes');
	downloadBtn.onclick = function () {
		downloadHistoryRecord(record);
	};
	actions.appendChild(downloadBtn);

	item.appendChild(title);
	item.appendChild(meta);
	item.appendChild(actions);
	return item;
}

function downloadHistoryRecord(record) {
	if (!record || !record.sesContent) return;
	const blob = new Blob([record.sesContent], { type: 'text/plain' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	const stamp = formatFileTimestamp(record.createdAt);
	const baseName = record.fileName || 'output';
	a.href = url;
	a.download = `${baseName}_${stamp}.ses`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

function addHistoryRecord(pcbData) {
	if (!originalFile) return;
	try {
		const dsnInfo = parseDsnInfo(originalFile);
		dsnInfo.fileName = fileName;
		dsnInfo.isJlcConverted = isJlcConverted;
		const params = getCurrentParams();
		const sesContent = convertPcbToSes(pcbData, dsnInfo, { gap: params.g });
		const timestamp = Date.now();
		historyRecords.unshift({
			id: String(timestamp),
			fileName: fileName,
			createdAt: timestamp,
			params: params,
			sesContent: sesContent,
		});
		if (historyRecords.length > HISTORY_LIMIT) {
			historyRecords = historyRecords.slice(0, HISTORY_LIMIT);
		}
		persistHistory();
		renderHistory();
	} catch (err) {}
}

//go button handler
let workerBlobUrl = null;

async function loadTextFile(relativePath) {
	if (typeof eda !== 'undefined' && eda?.sys_FileSystem?.getExtensionFile) {
		const f = await eda.sys_FileSystem.getExtensionFile('/iframe/jspcb/' + relativePath);
		if (f) return await f.text();
	}
	const r = await fetch('/iframe/jspcb/' + relativePath);
	return await r.text();
}

async function createRoutingWorker() {
	try {
		return new Worker('/iframe/jspcb/worker.js');
	} catch (e) {}

	const mymath = await loadTextFile('mymath.js');
	const layer = await loadTextFile('layer.js');
	const router = await loadTextFile('router.js');
	const workerSource = await loadTextFile('worker.js');
	const cleanedWorker = workerSource.replace(/^\s*importScripts\([^\)]*\);\s*/m, '');
	const combined = `${mymath}\n${layer}\n${router}\n${cleanedWorker}\n`;
	workerBlobUrl = URL.createObjectURL(new Blob([combined], { type: 'application/javascript' }));
	return new Worker(workerBlobUrl);
}

async function handleOnGo(evt) {
	if (file !== null) {
		//params
		let arg_g = +document.getElementById('arg_g').value;
		let arg_t = +document.getElementById('arg_t').value;
		let arg_v = +document.getElementById('arg_v').value;
		let arg_s = +document.getElementById('arg_s').value;
		let arg_z = +document.getElementById('arg_z').value;
		let arg_r = +document.getElementById('arg_r').value;
		let arg_q = +document.getElementById('arg_q').value;
		let arg_d = +document.getElementById('arg_d').value;
		let arg_fr = +document.getElementById('arg_fr').value;
		let arg_xr = +document.getElementById('arg_xr').value;
		let arg_yr = +document.getElementById('arg_yr').value;

		// Reset log UI
		logRecords = [];
		document.getElementById('log-content').innerHTML = '';
		appendLog('log.init');
		document.getElementById('go').disabled = true;
		shouldSaveHistory = false;
		startTimer();

		//run pcb solver web worker thread, register output listner
		if (worker !== null) worker.terminate();
		if (workerBlobUrl) {
			try {
				URL.revokeObjectURL(workerBlobUrl);
			} catch {}
			workerBlobUrl = null;
		}
		try {
			worker = await createRoutingWorker();
		} catch (e) {
			const msg = e && e.message ? e.message : String(e);
			appendLog('log.workerCreateFail', msg);
			document.getElementById('go').disabled = false;
			stopTimer();
			return;
		}
		worker.addEventListener(
			'message',
			function (event) {
				// Handle log messages
				if (event.data.type === 'log') {
					appendLog(event.data.message);
					return;
				}

				// Handle legacy array data (result)
				let pcbData = event.data;
				if (event.data.type === 'result') {
					pcbData = event.data.data;
				}

				if (pcbData.length) {
					//保存布线结果
					lastPcbData = pcbData;
					//启用导出按钮
					document.getElementById('export_ses').disabled = false;

					//view the pcb output with auto-scaling (scale=0)
					js_pcb.view_pcb(pcbData, 0, 2);

					// The existing worker sends a completion log before its final array.
					if (shouldSaveHistory) {
						addHistoryRecord(pcbData);
						shouldSaveHistory = false;
					}
				}
			},
			false,
		);

		//post to solver thread
		worker.postMessage([js_pcb.dsn2pcb(file, arg_g), arg_t, arg_v, arg_s, arg_z, arg_r, arg_q, arg_d, arg_fr, arg_xr, arg_yr]);
	}
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

	// Completion is based on the original protocol, independent of display language.
	if (message.includes('所有采样完成')) {
		document.getElementById('go').disabled = false;
		shouldSaveHistory = true;
		stopTimer();
	}
}

//导出 SES 文件
async function handleExportSes(evt) {
	if (lastPcbData === null || originalFile === null) {
		alert(t('error.runFirst'));
		return;
	}

	try {
		// 解析原始 DSN 信息
		const dsnInfo = parseDsnInfo(originalFile);
		dsnInfo.fileName = fileName;
		dsnInfo.isJlcConverted = isJlcConverted;

		// 获取 gap 参数
		const gap = +document.getElementById('arg_g').value;

		// 转换为 SES 格式
		const sesContent = convertPcbToSes(lastPcbData, dsnInfo, { gap: gap });

		// EDA 环境：直接导入
		if (typeof eda !== 'undefined' && eda?.pcb_Document?.importAutoRouteSesFile) {
			console.log('[jspcb][eda] importAutoRouteSesFile');
			const sesFile = new File([sesContent], fileName + '.ses', { type: 'text/plain' });
			try {
				await eda.pcb_Document.importAutoRouteSesFile(sesFile);
				eda?.sys_Message?.showToastMessage?.(t('toast.imported'), 'success', 3);
			} catch (e) {
				console.error('[jspcb][eda] import failed', e);
				try {
					if (eda?.sys_FileSystem?.saveFile) {
						await eda.sys_FileSystem.saveFile(sesFile, sesFile.name);
						eda?.sys_Message?.showToastMessage?.(t('toast.importSaved'), 'warning', 6);
					} else {
						eda?.sys_Message?.showToastMessage?.(t('toast.importFail'), 'error', 6);
					}
				} catch (e2) {
					console.error('[jspcb][eda] save fallback failed', e2);
					eda?.sys_Message?.showToastMessage?.(t('toast.importFailSave'), 'error', 8);
				}
			}
			return;
		}

		// 下载文件
		const blob = new Blob([sesContent], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = fileName + '.ses';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	} catch (err) {
		alert(t('error.export', err.message));
		console.error(err);
	}
}

//file onload handler
function handleOnLoad(evt) {
	//the onload get a string of the dsn file
	let content = evt.target.result;
	originalFile = content; // 保存原始内容
	isJlcConverted = false;

	// 检查是否需要 JLC 格式转换
	if (document.getElementById('jlc_convert').checked) {
		try {
			content = convertJlcToKicad(content);
			isJlcConverted = true;
			console.log('JLC 格式已转换');
		} catch (err) {
			console.error('JLC 转换失败:', err);
			alert(t('error.convert', err.message));
		}
	}

	file = content;
	// 重置导出按钮
	document.getElementById('export_ses').disabled = true;
	lastPcbData = null;
}

//file selection handler
function handleFileSelect(evt) {
	//filelist
	let files = evt.target.files;
	let f = files[0];

	//dsn files only.
	if (f.name.match('.*[.]dsn')) {
		// 保存文件名
		fileName = f.name.replace('.dsn', '');

		//file reader
		let reader = new FileReader();

		//onload handler
		reader.onload = handleOnLoad;

		//read the dsn file
		reader.readAsText(f);
	}
}

// Resize handler to re-render SVG on window resize
window.addEventListener('resize', function () {
	if (lastPcbData) {
		// Re-render with auto-scaling
		js_pcb.view_pcb(lastPcbData, 0, 2);
	}
});

//register action handlers
document.getElementById('files').addEventListener('change', handleFileSelect, false);
document.getElementById('go').onclick = handleOnGo;
document.getElementById('export_ses').onclick = handleExportSes;
document.getElementById('clear_history').onclick = function () {
	historyRecords = [];
	persistHistory();
	renderHistory();
};

historyRecords = loadHistory();
renderHistory();

async function tryLoadDsnFromEda() {
	try {
		if (typeof eda === 'undefined' || !eda?.pcb_ManufactureData?.getDsnFile) return;
		console.log('[jspcb][eda] getDsnFile...');
		eda?.sys_Message?.showToastMessage?.(t('toast.fetchingDsn'), 'info', 2);
		const dsnFile = await eda.pcb_ManufactureData.getDsnFile();
		const dsnContent = typeof dsnFile === 'string' ? dsnFile : await dsnFile.text();
		console.log('[jspcb][eda] DSN length', dsnContent.length);

		const checkbox = document.getElementById('jlc_convert');
		if (checkbox) checkbox.checked = true;

		const info = typeof parseDsnInfo === 'function' ? parseDsnInfo(dsnContent) : null;
		if (info && info.fileName) fileName = info.fileName;
		handleOnLoad({ target: { result: dsnContent } });
		eda?.sys_Message?.showToastMessage?.(t('toast.dsnLoaded'), 'success', 2);
	} catch (e) {
		console.error('[jspcb][eda] load DSN failed', e);
		eda?.sys_Message?.showToastMessage?.(t('toast.dsnFail'), 'error', 6);
	}
}

document.addEventListener('jspcb-lang-change', function () {
	renderHistory();
	renderLogs();
});

function initializeEdaUi() {
	try {
		const isEda = typeof eda !== 'undefined' && !!eda?.pcb_ManufactureData?.getDsnFile;
		const fileInputWrapper = document.getElementById('file_input_wrapper');
		const edaInputGroup = document.getElementById('eda_input_group');
		const loadBtn = document.getElementById('load_dsn_eda');
		const exportBtn = document.getElementById('export_ses');

		if (isEda) {
			if (fileInputWrapper) fileInputWrapper.style.display = 'none';
			if (edaInputGroup) edaInputGroup.style.display = 'flex';
			if (exportBtn) {
				exportBtn.setAttribute('data-i18n', 'ui.importSes');
				exportBtn.innerText = t('ui.importSes');
			}
			if (loadBtn) {
				loadBtn.onclick = function () {
					tryLoadDsnFromEda();
				};
			}
			tryLoadDsnFromEda();
		} else {
			if (exportBtn) exportBtn.innerText = t('ui.exportSes');
		}
	} catch (e) {
		console.error('[jspcb] init ui failed', e);
	}
}

jspcbI18n.ready.then(initializeEdaUi);
