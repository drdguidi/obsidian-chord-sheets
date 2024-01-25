// noinspection JSUnusedGlobalSymbols

import {Editor, MarkdownFileInfo, MarkdownView, Plugin, View} from 'obsidian';
import {Chord} from "tonal";
import {EditorView, ViewPlugin} from "@codemirror/view";
import {ChordToken, Instrument, transposeTonic} from "./chordsUtils";
import {ChordBlockPostProcessorView} from "./chordBlockPostProcessorView";
import {ChordSheetsSettings, DEFAULT_SETTINGS} from "./chordSheetsSettings";
import {ChangeSpec, Extension} from "@codemirror/state";
import {
	chordSheetEditorPlugin,
	ChordSheetsViewPlugin,
	TransposeEventDetail
} from "./editor-extension/chordSheetsViewPlugin";
import {InstrumentChangeEventDetail} from "./editor-extension/chordBlockToolsWidget";
import {AutoscrollControl} from "./autoscrollControl";
import {ChordSheetsSettingTab} from "./chordSheetsSettingTab";
import {IChordSheetsPlugin} from "./chordSheetsPluginInterface";
import {chordSheetsEditorExtension} from "./editor-extension/chordSheetsEditorExtension";


export default class ChordSheetsPlugin extends Plugin implements IChordSheetsPlugin {
	settings: ChordSheetsSettings;
	editorPlugin: ViewPlugin<ChordSheetsViewPlugin>;
	editorExtension: Extension[] | null;

	viewAutoscrollControlMap = new WeakMap<View, AutoscrollControl>();

	async onload() {
		await this.loadSettings();


		// Register code block post processor for reading mode

		this.registerMarkdownPostProcessor((element, context) => {

			const codeblocks = element.querySelectorAll("code[class*=language-chords]");
			for (let index = 0; index < codeblocks.length; index++) {
				const codeblock = codeblocks.item(index);
				const langClass = Array.from(codeblock.classList).find(cls => cls.startsWith("language-chords"))?.substring(9);
				if (langClass) {
					const instrumentString = langClass.split("-")[1];
					const instrument = instrumentString as Instrument ?? this.settings.defaultInstrument;
					context.addChild(new ChordBlockPostProcessorView(
						codeblock.parentElement!,
						instrument as Instrument,
						this.settings.showChordOverview === "always" || this.settings.showChordOverview === "preview",
						this.settings.showChordDiagramsOnHover === "always" || this.settings.showChordDiagramsOnHover === "preview",
						this.settings.diagramWidth
					));
				}
			}

		});



		// Register editor extension for edit / live preview mode

		this.editorPlugin = chordSheetEditorPlugin();
		this.editorExtension = chordSheetsEditorExtension(this.settings, this.editorPlugin);
		this.registerEditorExtension(this.editorExtension);


		// Handle chord sheet custom events sent by the editor extension

		this.registerDomEvent(window, "chord-sheet-instrument-change", (event: CustomEvent<InstrumentChangeEventDetail>) => {
			const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
			const { selectedInstrument, from } = event.detail;
			if (editor) {
				// @ts-expect-error, not typed
				const editorView = editor.cm as EditorView;
				this.changeInstrument(editorView, selectedInstrument as Instrument, from);
			}
		});

		this.registerDomEvent(window, "chord-sheet-transpose", async (event: CustomEvent<TransposeEventDetail>) => {
			const {direction, blockDef} = event.detail;
			const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;

			if (editor) {
				// @ts-ignore
				const editorView = editor.cm as EditorView;
				const chordPlugin = editorView?.plugin(this.editorPlugin);
				if (chordPlugin) {
					const chordTokens = await chordPlugin.getChordTokensForBlock(blockDef);
					this.transpose(chordTokens, editorView, direction);
				}
			}
		});


		// Handle obsidian events

		this.app.workspace.on("file-open", () => {
			this.stopAllAutoscrolls();
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view) {
				this.updateAutoscrollButton(view);
			}
		});

		this.app.workspace.on("editor-change", (_editor, view) => {
			this.updateAutoscrollButton(view);
		});


		// Register editor commands

		this.addCommand({
			id: 'chord-sheet-instrument-change-default',
			name: `Change instrument for the current chord block to the default instrument (${(this.settings.defaultInstrument)})`,
			editorCheckCallback: (checking: boolean, _editor: Editor, view: MarkdownView)  => {
				return this.changeInstrumentCommand(view, this.editorPlugin, checking, null);
			}
		});

		this.addCommand({
			id: 'chord-sheet-instrument-change-ukulele',
			name: 'Change instrument for the current chord block to ukulele',
			editorCheckCallback: (checking: boolean, _editor: Editor, view: MarkdownView)  => {
				return this.changeInstrumentCommand(view, this.editorPlugin, checking, "ukulele");
			}
		});

		this.addCommand({
			id: 'chord-sheet-instrument-change-guitar',
			name: 'Change instrument for the current chord block to guitar',
			editorCheckCallback: (checking: boolean, _editor: Editor, view: MarkdownView) => {
				return this.changeInstrumentCommand(view, this.editorPlugin, checking, "guitar");
			}
		});

		this.addCommand({
			id: 'chord-sheet-transpose-up',
			name: 'Transpose current chord block one semitone up',
			editorCheckCallback: (checking: boolean, editor: Editor) =>
				this.transposeCommand(editor, this.editorPlugin, checking, "up")
		});

		this.addCommand({
			id: 'chord-sheet-transpose-down',
			name: 'Transpose current chord block one semitone down',
			editorCheckCallback: (checking: boolean, editor: Editor) =>
				this.transposeCommand(editor, this.editorPlugin, checking, "down")
		});

		this.addCommand({
			id: 'chord-sheet-toggle-autoscroll',
			name: 'Toggle autoscroll',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) {
					return false;
				}

				if (!checking) {
					this.toggleAutoscroll(view);
				}

				return true;
			}
		});

		this.addCommand({
			id: 'chord-sheet-autoscroll-increase',
			name: 'Increase autoscroll speed',
			editorCheckCallback: (checking: boolean) => this.adjustScrollSpeedCommand('increase', checking)
		});

		this.addCommand({
			id: 'chord-sheet-autoscroll-decrease',
			name: 'Decrease autoscroll speed',
			editorCheckCallback: (checking: boolean) => this.adjustScrollSpeedCommand('decrease', checking)
		});


		// Add the settings tab
		this.addSettingTab(new ChordSheetsSettingTab(this.app, this));

	}

	private changeInstrumentCommand(view: MarkdownView, plugin: ViewPlugin<ChordSheetsViewPlugin>, checking: boolean, instrument: Instrument | null) {
		// @ts-expect-error, not typed
		const editorView = view.editor.cm as EditorView;
		const chordPlugin = editorView.plugin(plugin);
		if (chordPlugin) {
			const chordSheetBlockAtCursor = chordPlugin.getChordSheetBlockAtCursor();
			if (!chordSheetBlockAtCursor) {
				return false;
			}

			if (!checking) {
				this.changeInstrument(editorView, instrument, chordSheetBlockAtCursor.from);
			}
		}

		return true;
	}

	private transposeCommand(editor: Editor, plugin: ViewPlugin<ChordSheetsViewPlugin>, checking: boolean, direction: "up" | "down") {
		// @ts-expect-error, not typed
		const editorView = editor.cm as EditorView;
		const chordPlugin = editorView.plugin(plugin);
		if (chordPlugin) {
			const chordSheetBlockAtCursor = chordPlugin.getChordSheetBlockAtCursor();
			if (!chordSheetBlockAtCursor) {
				return false;
			}

			if (!checking) {
				chordPlugin.getChordTokensForBlock(chordSheetBlockAtCursor).then(
					chordTokens => this.transpose(chordTokens, editorView, direction)
				);
			}
		}

		return true;
	}

	private adjustScrollSpeedCommand(action: 'increase' | 'decrease', checking: boolean) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			return false;
		}

		const autoscrollControl = this.viewAutoscrollControlMap.get(view);
		if (!autoscrollControl || !autoscrollControl.isRunning) {
			return false;
		}

		if (!checking) {
			if (autoscrollControl) {
				action === 'increase' ? autoscrollControl.increaseSpeed() : autoscrollControl.decreaseSpeed();
			}
		}

		return true;
	}

	private changeInstrument(editor: EditorView, selectedInstrument: Instrument | null, blockStart: number) {
		const languageSpecifier = this.settings.blockLanguageSpecifier;
		const newInstrumentDef = selectedInstrument === null
			? languageSpecifier
			: `${languageSpecifier}-${selectedInstrument}`;
		const editorView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (editorView) {
			const lineNo = editorView.editor.offsetToPos(blockStart).line;
			const startLine = editorView.editor.getLine(lineNo);
			const newLine = startLine.replace(/\w+\S+/, newInstrumentDef);
			// editorView.editor.setLine(lineNo, newLine)
			editor.plugin(this.editorPlugin)?.applyChanges([{
				from: blockStart,
				to: blockStart + startLine.length,
				insert: newLine
			}]);
		}
	}

	private transpose(chordTokenRanges: {from: number, to: number, chordToken: ChordToken}[], editor: EditorView, direction: "up" | "down") {
		const changes: ChangeSpec[] = [];
		for (const chordTokenRange of chordTokenRanges) {
			const chordToken = chordTokenRange.chordToken;
			const [chordTonic, chordType] = Chord.tokenize(chordToken.value);
			const simplifiedTonic = transposeTonic(chordTonic, direction);

			let transposedChord;

			// As tonal.js does not support slash chord, handle them manually
			if (chordType && chordType.includes('/')) {
				const [slashChordType, afterSlash] = chordType.split('/');
				transposedChord = simplifiedTonic + slashChordType + "/" + transposeTonic(afterSlash, direction);
			} else {
				transposedChord = simplifiedTonic + (chordType ?? "");
			}

			const chordStartIndex = chordTokenRange.from;
			const chordEndIndex = chordTokenRange.to;
			changes.push({from: chordStartIndex, to: chordEndIndex, insert: transposedChord});
		}
		editor.plugin(this.editorPlugin)?.applyChanges(changes);
	}

	private toggleAutoscroll(view: MarkdownView) {
		const autoscrollControl = this.viewAutoscrollControlMap.get(view);

		if (autoscrollControl?.isRunning) {
			autoscrollControl.stop();
		} else {
			this.startAutoscroll(view);
		}

		this.updateAutoscrollButton(view);

	}

	private updateAutoscrollButton(view: MarkdownView | MarkdownFileInfo) {
		// @ts-expect-error, not typed
		const editorView = view.editor.cm as EditorView;
		const plugin = editorView.plugin(this.editorPlugin);
		if (plugin && view instanceof MarkdownView) {
			const existingEl: HTMLElement | null = view.containerEl.querySelector(".chord-sheet-autoscroll-action");

			const shouldShowButton = this.settings.showAutoscrollButton === "always"
				|| (
					plugin.hasChordBlocks() && this.settings.showAutoscrollButton === "chord-blocks"
				);

			if (shouldShowButton) {
				const autoscrollControl = this.viewAutoscrollControlMap.get(view);
				const icon = autoscrollControl?.isRunning ? "pause-circle" : "play-circle";
				if (!existingEl || icon !== existingEl.dataset.icon) {
					existingEl?.remove();
					const viewEl = view.addAction(icon, "Toggle autoscroll", () => {
						this.toggleAutoscroll(view);
					});
					viewEl.addClass("chord-sheet-autoscroll-action");
					viewEl.dataset.icon = icon;
				}
			} else if (existingEl) {
				existingEl.remove();
			}
		}
	}

	private startAutoscroll(view: MarkdownView) {
		const autoscrollControl = this.viewAutoscrollControlMap.get(view)
			?? new AutoscrollControl(view, this.settings.autoscrollDefaultSpeed);
		this.viewAutoscrollControlMap.set(view, autoscrollControl);
		autoscrollControl.start();
	}

	stopAllAutoscrolls() {
		this.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view.getViewType() === "markdown") {
				const autoscrollControl = this.viewAutoscrollControlMap.get(leaf.view);
				autoscrollControl?.stop();
			}
		});
	}

	applyNewSettingsToEditors() {
		this.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view.getViewType() === "markdown") {
				const markdownView = leaf.view as MarkdownView;
				// @ts-expect-error, not typed
				const editorView = markdownView.editor.cm as EditorView;
				const chordPlugin = editorView.plugin(this.editorPlugin);
				chordPlugin?.updateSettings(this.settings);
			}
		});

		if (this.editorExtension) {
			this.editorExtension.length = 0;
			this.editorExtension.push(...chordSheetsEditorExtension(this.settings, this.editorPlugin));
			this.app.workspace.updateOptions();
		}
	}


	onunload() {
		this.stopAllAutoscrolls();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
