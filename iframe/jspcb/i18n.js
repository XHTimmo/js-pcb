/**
 * Adapted from PR #1 by  (@easyeda2021).
 * https://github.com/XHTimmo/js-pcb/pull/1
 * Modified for the existing manual-import workflow; see NOTICE.md.
 */
'use strict';

var jspcbI18n = (function () {
	const dictionaries = new Map();
	let lang = 'zh-Hans';
	let dict = {};
	let fallback = {};
	let languageRequest = 0;

	function normalizeLang(value) {
		return typeof value === 'string' && /^zh/i.test(value) ? 'zh-Hans' : 'en';
	}

	async function readText(path) {
		try {
			if (typeof eda !== 'undefined' && eda?.sys_FileSystem?.getExtensionFile) {
				const file = await eda.sys_FileSystem.getExtensionFile(path);
				if (file) return await file.text();
			}
		} catch (e) {
			// Browser loading is also available when the extension file API fails.
		}
		const response = await fetch(path);
		if (!response.ok) throw new Error('Cannot load ' + path);
		return await response.text();
	}

	function loadDict(target) {
		if (!dictionaries.has(target)) {
			dictionaries.set(
				target,
				readText('/locales/' + target + '.json')
					.then(JSON.parse)
					.catch(function (error) {
						console.warn('[jspcb][i18n] Failed to load', target, error);
						dictionaries.delete(target);
						return {};
					}),
			);
		}
		return dictionaries.get(target);
	}

	async function detectLanguage() {
		try {
			if (typeof eda !== 'undefined' && eda?.sys_I18n?.getCurrentLanguage) {
				const current = await eda.sys_I18n.getCurrentLanguage();
				if (current) return normalizeLang(current);
			}
		} catch (e) {
			console.warn('[jspcb][i18n] Language detection failed', e);
		}
		return normalizeLang(typeof navigator !== 'undefined' ? navigator.language : 'zh-Hans');
	}

	function t(key, ...args) {
		const text = dict[key] ?? fallback[key] ?? key;
		return String(text).replace(/\$\{(\d+)\}/g, function (match, index) {
			return String(args[Number(index) - 1] ?? '');
		});
	}

	function apply() {
		document.documentElement.lang = lang;
		document.querySelectorAll('[data-i18n]').forEach(function (element) {
			element.textContent = t(element.getAttribute('data-i18n'));
		});
		for (const attribute of ['title', 'aria-label']) {
			document.querySelectorAll('[data-i18n-' + attribute + ']').forEach(function (element) {
				element.setAttribute(attribute, t(element.getAttribute('data-i18n-' + attribute)));
			});
		}
		const button = document.getElementById('lang_btn');
		if (button) button.innerText = lang === 'en' ? '中' : 'EN';
		document.dispatchEvent(new CustomEvent('jspcb-lang-change', { detail: { lang: lang } }));
	}

	async function setLang(target) {
		const request = ++languageRequest;
		const next = normalizeLang(target);
		const other = next === 'en' ? 'zh-Hans' : 'en';
		const result = await Promise.all([loadDict(next), loadDict(other)]);
		if (request !== languageRequest) return;
		lang = next;
		dict = result[0];
		fallback = result[1];
		apply();
	}

	const ready = detectLanguage().then(setLang);
	return {
		t: t,
		apply: apply,
		setLang: setLang,
		getLang: function () {
			return lang;
		},
		ready: ready,
	};
})();
