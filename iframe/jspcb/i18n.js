/**
 * 轻量多语言模块
 *
 * 启动时优先读取 EasyEDA 当前语言环境（eda.sys_I18n.getCurrentLanguage），
 * 从扩展的 /locales/<lang>.json 加载词条并应用到带 data-i18n 的元素。
 * 同时提供 t(key, ...args) 给动态文案使用。
 */
"use strict";

var jspcbI18n = (function()
{
	const SUPPORTED = ["zh-Hans", "en"];

	let lang = "zh-Hans";
	let dict = {};
	let fallback = {};
	let ready = null;

	function normalizeLang(value)
	{
		if (typeof value === "string" && /^zh/i.test(value)) return "zh-Hans";
		return "en";
	}

	async function readText(path)
	{
		// EDA 环境优先走扩展文件系统，浏览器环境回退到 fetch
		try
		{
			if (typeof eda !== "undefined" && eda?.sys_FileSystem?.getExtensionFile)
			{
				const file = await eda.sys_FileSystem.getExtensionFile(path);
				if (file) return await file.text();
			}
		}
		catch (e)
		{
			// 继续尝试 fetch
		}

		const candidates = [path, path.replace(/^\//, "")];
		for (const candidate of candidates)
		{
			try
			{
				const res = await fetch(candidate);
				if (res.ok) return await res.text();
			}
			catch (e)
			{
				// 尝试下一个路径
			}
		}
		throw new Error("cannot load " + path);
	}

	async function loadDict(target)
	{
		try
		{
			const text = await readText("/locales/" + target + ".json");
			const data = JSON.parse(text);
			return (data && typeof data === "object") ? data : {};
		}
		catch (e)
		{
			console.warn("[jspcb][i18n] failed to load", target, e);
			return {};
		}
	}

	async function detectLanguage()
	{
		try
		{
			if (typeof eda !== "undefined" && eda?.sys_I18n?.getCurrentLanguage)
			{
				const current = await eda.sys_I18n.getCurrentLanguage();
				if (typeof current === "string" && current) return normalizeLang(current);
			}
		}
		catch (e)
		{
			console.warn("[jspcb][i18n] detect failed", e);
		}

		const nav = (typeof navigator !== "undefined" && navigator.language) ? navigator.language : "zh-Hans";
		return normalizeLang(nav);
	}

	function format(text, args)
	{
		return String(text).replace(/\$\{(\d+)\}/g, function(match, index) {
			const value = args[Number(index) - 1];
			return value === undefined || value === null ? "" : String(value);
		});
	}

	function t(key, ...args)
	{
		const text = dict[key] !== undefined ? dict[key] : fallback[key];
		if (text === undefined) return key;
		return format(text, args);
	}

	function updateLanguageButton()
	{
		const btn = document.getElementById("lang_btn");
		if (!btn) return;
		// 按钮显示“将要切换到的语言”
		btn.innerText = lang === "en" ? "中" : "EN";
		btn.title = t("ui.language");
	}

	function apply()
	{
		document.querySelectorAll("[data-i18n]").forEach(function(el) {
			el.textContent = t(el.getAttribute("data-i18n"));
		});
		document.querySelectorAll("[data-i18n-title]").forEach(function(el) {
			el.title = t(el.getAttribute("data-i18n-title"));
		});
		updateLanguageButton();
		document.dispatchEvent(new CustomEvent("jspcb-lang-change", { detail: { lang: lang } }));
	}

	async function useLanguage(target)
	{
		lang = SUPPORTED.indexOf(target) >= 0 ? target : "en";
		const other = lang === "en" ? "zh-Hans" : "en";
		const result = await Promise.all([loadDict(lang), loadDict(other)]);
		dict = result[0];
		fallback = result[1];
		apply();
	}

	async function setLang(target)
	{
		await useLanguage(normalizeLang(target));
	}

	function getLang()
	{
		return lang;
	}

	async function init()
	{
		const detected = await detectLanguage();
		await useLanguage(detected);
	}

	ready = init();

	return {
		t: t,
		apply: apply,
		setLang: setLang,
		getLang: getLang,
		ready: ready
	};
})();
