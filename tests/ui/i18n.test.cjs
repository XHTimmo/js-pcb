const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const dictionaries = Object.fromEntries(['en', 'zh-Hans'].map((lang) => [lang, JSON.parse(read(`locales/${lang}.json`))]));

function runtime({ browserLanguage = 'en', eda, fetchDictionary } = {}) {
	const events = [];
	const elements = new Map();
	const document = {
		documentElement: {},
		querySelectorAll: () => [],
		getElementById: (id) => elements.get(id) || null,
		dispatchEvent: (event) => events.push(event),
		addEventListener() {},
	};
	const context = vm.createContext({
		document,
		navigator: { language: browserLanguage },
		console: { warn() {} },
		CustomEvent: class {
			constructor(type, options) {
				this.type = type;
				this.detail = options.detail;
			}
		},
		fetch: async (url) => {
			const lang = path.basename(url, '.json');
			const dict = fetchDictionary ? await fetchDictionary(lang) : dictionaries[lang];
			return { ok: true, text: async () => JSON.stringify(dict) };
		},
		...(eda ? { eda } : {}),
	});
	vm.runInContext(read('iframe/jspcb/i18n.js'), context);
	return { context, i18n: context.jspcbI18n, document, events, elements };
}

test('both locales cover UI, dynamic strings and identical interpolation placeholders', () => {
	assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries['zh-Hans']).sort());
	for (const [key, value] of Object.entries(dictionaries.en)) {
		assert.deepEqual(value.match(/\$\{\d+\}/g), dictionaries['zh-Hans'][key].match(/\$\{\d+\}/g), key);
	}
	const sources = ['iframe/jspcb/index.html', 'iframe/jspcb/main.js', 'iframe/jspcb/ui.js', 'src/index.ts'].map(read).join('\n');
	const keys = sources.matchAll(/(?:data-i18n(?:-title|-aria-label)?="|['"])((?:ui|toast|error|log)\.[\w]+)(?:['"])/g);
	for (const [, key] of keys) assert.ok(key in dictionaries.en, `Missing translation: ${key}`);
});

test('EDA language takes priority over browser language and updates document language', async () => {
	const app = runtime({ browserLanguage: 'en-US', eda: { sys_I18n: { getCurrentLanguage: async () => 'zh-Hant' } } });
	await app.i18n.ready;
	assert.equal(app.i18n.getLang(), 'zh-Hans');
	assert.equal(app.document.documentElement.lang, 'zh-Hans');
	assert.equal(app.i18n.t('ui.start'), '开始布线');
	assert.equal(app.events.at(-1).detail.lang, 'zh-Hans');
});

test('failed EDA language and file APIs fall back to browser language and HTTP', async () => {
	const fail = async () => {
		throw new Error('API unavailable');
	};
	const app = runtime({ browserLanguage: 'en-GB', eda: { sys_I18n: { getCurrentLanguage: fail }, sys_FileSystem: { getExtensionFile: fail } } });
	await app.i18n.ready;
	assert.equal(app.i18n.t('ui.start'), 'Start routing');
	assert.equal(app.i18n.t('log.legacySampleDone', 1, 2, '0.25', 42), '[Sample 1/2] Done! Time: 0.25s, cost: 42');
	assert.equal(app.i18n.t('log.sampleDone', 1, 2, '0.25', 3, 4, 42), '[Sample 1/2] Done: 0.25s, routed 3/4, cost 42');
	assert.equal(app.i18n.t('unknown.key'), 'unknown.key');
});

test('extension file API loads dictionaries without fetch and unsupported languages use English', async () => {
	const app = runtime({
		eda: {
			sys_I18n: { getCurrentLanguage: async () => 'de' },
			sys_FileSystem: {
				getExtensionFile: async (url) => ({ text: async () => JSON.stringify(dictionaries[path.basename(url, '.json')]) }),
			},
		},
		fetchDictionary: () => {
			throw new Error('HTTP should not be used');
		},
	});
	await app.i18n.ready;
	assert.equal(app.i18n.t('ui.start'), 'Start routing');
});

test('missing translations fall back, failed dictionary loads can be retried', async () => {
	let failedOnce = false;
	const app = runtime({
		fetchDictionary: async (lang) => {
			if (lang === 'en' && !failedOnce) {
				failedOnce = true;
				throw new Error('Transient error');
			}
			return dictionaries[lang];
		},
	});
	await app.i18n.ready;
	assert.equal(app.i18n.t('ui.start'), '开始布线');
	await app.i18n.setLang('en');
	assert.equal(app.i18n.t('ui.start'), 'Start routing');
});

test('the last language request wins when switches overlap', async () => {
	const app = runtime();
	await app.i18n.ready;
	await Promise.all([app.i18n.setLang('zh-Hans'), app.i18n.setLang('en')]);
	assert.equal(app.i18n.getLang(), 'en');
	await Promise.all([app.i18n.setLang('en'), app.i18n.setLang('zh-Hans')]);
	assert.equal(app.i18n.getLang(), 'zh-Hans');
});

test('legacy worker log messages translate without changing the worker protocol', async () => {
	const app = runtime();
	await app.i18n.ready;
	for (const id of ['lang_btn', 'help_modal', 'help_btn', 'help_close']) {
		app.elements.set(id, { addEventListener() {} });
	}
	vm.runInContext(read('iframe/jspcb/ui.js'), app.context);
	const format = app.context.jspcbUi.formatLog;
	assert.equal(format('[采样 1/2] 开始布线...'), '[Sample 1/2] Starting routing…');
	assert.equal(format('[采样 1/2] 完成! 耗时: 1.25s, 代价: 42'), '[Sample 1/2] Done! Time: 1.25s, cost: 42');
	assert.equal(format('所有采样完成。最佳代价: 42'), 'All samples complete. Best cost: 42');
	assert.equal(format('unexpected diagnostic'), 'unexpected diagnostic');
	await app.i18n.setLang('zh-Hans');
	assert.equal(format('所有采样完成。最佳代价: 42'), '所有采样完成。最佳代价：42');
});
