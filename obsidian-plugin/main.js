'use strict';

/*
 * TypeStat 字数上报 —— Obsidian 配套插件
 *
 * 为什么需要插件：全局键盘钩子只能数「按了多少次键」，数不出「打了几个字」。
 * 打一个汉字在钩子看来可能只是 1 次按键（输入法上屏），也可能 5 次（拼音逐个敲），
 * 钩子根本无从区分。只有编辑器自己知道这次改动增删了几个字符。
 *
 * 隐私边界：本插件只上报两个整数，正文一个字都不出 Obsidian，也不落任何日志。
 *
 * 数据来源优先级：
 *   1. CodeMirror 6 的 updateListener —— 拿到 changes 后逐段算增删长度，精确。
 *   2. 文档长度差分 —— 拿不到 CM 内部 API 时的退化路径，只能得到净变化量。
 */

const { Plugin, PluginSettingTab, Setting, requestUrl, Notice } = require('obsidian');

const DEFAULT_SETTINGS = {
	enabled: true,
	port: 42180,
	token: '',
	app: 'Obsidian.exe',
};

/** 攒多久上报一次。打字是连续动作，逐次上报会产生大量无用请求。 */
const FLUSH_INTERVAL_MS = 1000;

/**
 * 待上报数据的积压上限。接收端长期不在时不能无限攒——
 * 攒到这么多说明 TypeStat 根本没在跑，这些数字留着也没意义了。
 */
const MAX_PENDING = 200000;

/** 长度差分退化路径里记住多少个文件的长度，防止无界增长。 */
const MAX_TRACKED_FILES = 512;

class TypeStatSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'TypeStat 上报' });

		new Setting(containerEl)
			.setName('启用上报')
			.setDesc('关掉之后 Obsidian 就不再向 TypeStat 上报字数，打字统计会只剩按键口径。')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
					this.plugin.settings.enabled = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('端口')
			.setDesc('要跟 TypeStat「设置 → 精确字数适配器」里显示的端口一致。默认 42180。')
			.addText((t) =>
				t
					.setPlaceholder('42180')
					.setValue(String(this.plugin.settings.port))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (Number.isInteger(n) && n > 0 && n < 65536) {
							this.plugin.settings.port = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName('令牌')
			.setDesc('从 TypeStat 设置页复制过来。作用是防止本机其他程序往统计里灌数据。')
			.addText((t) => {
				t.setPlaceholder('粘贴 TypeStat 里的令牌')
					.setValue(this.plugin.settings.token)
					.onChange(async (v) => {
						this.plugin.settings.token = v.trim();
						await this.plugin.saveSettings();
					});
				t.inputEl.style.width = '100%';
			});

		new Setting(containerEl)
			.setName('应用名')
			.setDesc('上报时用的名字。保持 Obsidian.exe 才能让精确字数和按键数落在同一行统计里。')
			.addText((t) =>
				t
					.setPlaceholder('Obsidian.exe')
					.setValue(this.plugin.settings.app)
					.onChange(async (v) => {
						this.plugin.settings.app = v.trim() || 'Obsidian.exe';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('测试连接')
			.setDesc('向 TypeStat 发一个空上报，确认端口和令牌都对。')
			.addButton((b) =>
				b.setButtonText('测试').onClick(async () => {
					const result = await this.plugin.testConnection();
					new Notice(result.message, result.ok ? 4000 : 8000);
				})
			);

		const status = containerEl.createEl('p');
		status.style.opacity = '0.7';
		status.setText('最近状态：' + this.plugin.statusText());

		const notes = containerEl.createEl('p');
		notes.style.opacity = '0.7';
		notes.setText('本插件只上报两个整数（新增字符数、删除字符数），不读取也不上报任何正文内容。');
	}
}

module.exports = class TypeStatPlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		/** 待上报的累计量。 */
		this.pending = { input: 0, delete: 0 };
		/** 已经挂上精确监听的 EditorView，避免重复挂。 */
		this.attachedViews = new WeakSet();
		/** 退化路径用的「每个文件上次的长度」。 */
		this.lastLengths = new Map();

		this.overflowWarned = false;
		this.failureNotified = false;
		this.lastError = '';
		this.lastSuccessAt = 0;
		this.sentInput = 0;
		this.sentDelete = 0;

		this.registerEvent(
			this.app.workspace.on('editor-change', (editor, info) => this.onEditorChange(editor, info))
		);

		this.registerInterval(window.setInterval(() => this.flush(), FLUSH_INTERVAL_MS));

		// 插件加载时已经开着的笔记，先把监听挂上，
		// 否则这些文件里的第一次改动会被漏掉。剩下的交给 editor-change 惰性挂载。
		this.app.workspace.onLayoutReady(() => this.attachToOpenEditors());

		this.addSettingTab(new TypeStatSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** 给当前所有已打开的 markdown 编辑器挂精确监听。 */
	attachToOpenEditors() {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const editor = leaf.view && leaf.view.editor;
			if (editor) this.attachPreciseListener(editor);
		}
	}

	onEditorChange(editor, info) {
		if (!this.settings.enabled) return;
		// 精确路径已经接管这个编辑器时就不走差分，否则会重复计数。
		if (this.attachPreciseListener(editor)) return;
		this.trackByLength(editor, info);
	}

	/**
	 * 尝试给编辑器的 CodeMirror 6 视图挂上 updateListener。
	 *
	 * `editor.cm` 不是 Obsidian 的公开 API，所以整段都包在 try 里：
	 * 拿不到就返回 false，调用方退回长度差分，功能降级但不至于坏掉。
	 */
	attachPreciseListener(editor) {
		const view = editor && editor.cm;
		if (!view || typeof view.dispatch !== 'function') return false;
		if (this.attachedViews.has(view)) return true;

		try {
			const { EditorView } = require('@codemirror/view');
			const { StateEffect } = require('@codemirror/state');

			const listener = EditorView.updateListener.of((update) => {
				if (!update.docChanged) return;
				// iterChanges 回调里的 fromA/toA 是旧文档坐标，fromB/toB 是新文档坐标。
				// 所以：插入长度 = toB - fromB，删除长度 = toA - fromA。
				update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
					this.add(inserted.length, toA - fromA);
				});
			});

			// 监听器只能通过 appendConfig 追加到已有视图上（EditorState 不可变）。
			view.dispatch({ effects: StateEffect.appendConfig.of(listener) });
			this.attachedViews.add(view);
			return true;
		} catch (e) {
			return false;
		}
	}

	/**
	 * 退化路径：用文档长度差分推算净变化。
	 *
	 * 精度不如 updateListener：替换选区（选中一段再打字）会把「删 N 增 1」
	 * 记成净的 1-N，无法拆开。日常连续打字不受影响。
	 */
	trackByLength(editor, info) {
		const key = (info && info.file && info.file.path) || 'unknown';
		const len = editor.getValue().length;
		const prev = this.lastLengths.get(key);

		if (prev !== undefined) {
			const delta = len - prev;
			if (delta > 0) this.add(delta, 0);
			else if (delta < 0) this.add(0, -delta);
		}

		if (this.lastLengths.size >= MAX_TRACKED_FILES && !this.lastLengths.has(key)) {
			this.lastLengths.clear();
		}
		this.lastLengths.set(key, len);
	}

	/** 累计一笔增删。 */
	add(input, del) {
		if (input <= 0 && del <= 0) return;

		if (this.pending.input + this.pending.delete >= MAX_PENDING) {
			// 积压到顶了，直接丢新的。这时候 TypeStat 基本上就没在运行。
			if (!this.overflowWarned) {
				this.overflowWarned = true;
				new Notice('TypeStat：积压数据过多，已暂停上报。请确认 TypeStat 正在运行。', 8000);
			}
			return;
		}

		this.pending.input += input;
		this.pending.delete += del;
	}

	/** 把积压的数据发出去。失败会原样放回去，下一轮再试。 */
	async flush() {
		if (!this.settings.enabled) return;
		if (!this.settings.token) return;

		const batch = this.pending;
		if (batch.input === 0 && batch.delete === 0) return;

		// 先取走再发：发送期间新来的击键会进新的 pending，不会互相干扰。
		this.pending = { input: 0, delete: 0 };

		try {
			const res = await requestUrl({
				url: 'http://127.0.0.1:' + this.settings.port + '/report',
				method: 'POST',
				contentType: 'application/json',
				headers: { 'X-TypeStat-Token': this.settings.token },
				body: JSON.stringify({
					app: this.settings.app,
					input: batch.input,
					delete: batch.delete,
				}),
				throw: false,
			});

			if (res.status === 401 || res.status === 400) {
				// 请求本身有问题（多半是令牌不对），重试多少次都一样，丢掉更省事。
				this.lastError =
					res.status === 401 ? '令牌不匹配，请重新复制' : '请求被接收端拒绝';
				this.notifyFailureOnce();
				return;
			}
			if (res.status !== 200) throw new Error('HTTP ' + res.status);

			this.lastError = '';
			this.failureNotified = false;
			this.lastSuccessAt = Date.now();
			this.sentInput += batch.input;
			this.sentDelete += batch.delete;
		} catch (e) {
			// 接收端没开/还没起来：数据留着下次重试，别因为对方暂时不在就丢账。
			this.pending.input += batch.input;
			this.pending.delete += batch.delete;
			this.lastError = (e && e.message) || String(e);
			this.notifyFailureOnce();
		}
	}

	/** 只在第一次失败时弹一次提示，避免刷屏。 */
	notifyFailureOnce() {
		if (this.failureNotified) return;
		this.failureNotified = true;
		new Notice('TypeStat：上报失败（' + this.lastError + '）。请在 TypeStat 设置页核对端口和令牌。', 8000);
	}

	/** 主动测一次通路。发全零上报，接收端验完令牌直接回 200，不会写入任何数据。 */
	async testConnection() {
		if (!this.settings.token) {
			return { ok: false, message: '还没填令牌。请先在 TypeStat「设置 → 精确字数适配器」里复制。' };
		}
		try {
			const res = await requestUrl({
				url: 'http://127.0.0.1:' + this.settings.port + '/report',
				method: 'POST',
				contentType: 'application/json',
				headers: { 'X-TypeStat-Token': this.settings.token },
				body: JSON.stringify({ app: this.settings.app, input: 0, delete: 0 }),
				throw: false,
			});
			if (res.status === 200) {
				return { ok: true, message: '连接正常，TypeStat 已经收到你的令牌。' };
			}
			if (res.status === 401) {
				return { ok: false, message: '令牌不匹配。请回到 TypeStat 设置页重新复制。' };
			}
			return { ok: false, message: '接收端返回了 HTTP ' + res.status + '，请检查 TypeStat 是否在运行。' };
		} catch (e) {
			return {
				ok: false,
				message:
					'连不上 127.0.0.1:' + this.settings.port + '。请确认 TypeStat 正在运行，且端口填对了。',
			};
		}
	}

	statusText() {
		if (!this.settings.enabled) return '已停用';
		if (!this.settings.token) return '未配置令牌';
		if (this.lastSuccessAt) {
			const secs = Math.round((Date.now() - this.lastSuccessAt) / 1000);
			const when = secs < 60 ? secs + ' 秒前' : Math.round(secs / 60) + ' 分钟前';
			return '上次上报成功于 ' + when;
		}
		if (this.lastError) return '上报失败：' + this.lastError;
		return '本次会话还没有上报过数据';
	}
};
