/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { onUnexpectedError } from 'vs/base/common/errors';
import { IMarkdownString, markedStringsEquals } from 'vs/base/common/htmlContent';
import * as strings from 'vs/base/common/strings';
import { CharCode } from 'vs/base/common/charCode';
import { Range, IRange } from 'vs/editor/common/core/range';
import * as editorCommon from 'vs/editor/common/editorCommon';
import { TextModelWithTokens } from 'vs/editor/common/model/textModelWithTokens';
import { LanguageIdentifier } from 'vs/editor/common/modes';
import { ITextSource, IRawTextSource } from 'vs/editor/common/model/textSource';
import * as textModelEvents from 'vs/editor/common/model/textModelEvents';
import { ThemeColor } from 'vs/platform/theme/common/themeService';
import { IntervalNode, IntervalTree } from 'vs/editor/common/model/intervalTree';

export const ClassName = {
	EditorInfoDecoration: 'infosquiggly',
	EditorWarningDecoration: 'warningsquiggly',
	EditorErrorDecoration: 'errorsquiggly'
};

let _INSTANCE_COUNT = 0;
/**
 * Produces 'a'-'z', followed by 'A'-'Z'... followed by 'a'-'z', etc.
 */
function nextInstanceId(): string {
	const LETTERS_CNT = (CharCode.Z - CharCode.A + 1);

	let result = _INSTANCE_COUNT++;
	result = result % (2 * LETTERS_CNT);

	if (result < LETTERS_CNT) {
		return String.fromCharCode(CharCode.a + result);
	}

	return String.fromCharCode(CharCode.A + result - LETTERS_CNT);
}

export class TextModelWithDecorations extends TextModelWithTokens implements editorCommon.ITextModelWithDecorations {

	/**
	 * Used to workaround broken clients that might attempt using a decoration id generated by a different model.
	 * It is not globally unique in order to limit it to one character.
	 */
	private readonly _instanceId: string;
	private _lastDecorationId: number;
	private _currentDecorationsTrackerCnt: number;
	private _decorations: { [decorationId: string]: IntervalNode; };
	protected _decorationsTree: IntervalTree;

	constructor(rawTextSource: IRawTextSource, creationOptions: editorCommon.ITextModelCreationOptions, languageIdentifier: LanguageIdentifier) {
		super(rawTextSource, creationOptions, languageIdentifier);

		this._instanceId = nextInstanceId();
		this._lastDecorationId = 0;
		this._currentDecorationsTrackerCnt = 0;
		this._decorations = Object.create(null);
		this._decorationsTree = new IntervalTree();
	}

	public dispose(): void {
		this._decorations = null;
		this._decorationsTree = null;

		super.dispose();
	}

	protected _resetValue(newValue: ITextSource): void {
		super._resetValue(newValue);

		// Destroy all my decorations
		this._decorations = Object.create(null);
		this._decorationsTree = new IntervalTree();
	}

	_getTrackedRangesCount(): number {
		return this._decorationsTree.count();
	}

	// --- END TrackedRanges

	protected _acquireDecorationsTracker(): void {
		this._currentDecorationsTrackerCnt++;
	}

	protected _releaseDecorationsTracker(): void {
		this._currentDecorationsTrackerCnt--;
		if (this._currentDecorationsTrackerCnt === 0) {
			this._emitModelDecorationsChangedEvent();
		}
	}

	public changeDecorations<T>(callback: (changeAccessor: editorCommon.IModelDecorationsChangeAccessor) => T, ownerId: number = 0): T {
		this._assertNotDisposed();

		try {
			this._eventEmitter.beginDeferredEmit();
			this._acquireDecorationsTracker();
			return this._changeDecorations(ownerId, callback);
		} finally {
			this._releaseDecorationsTracker();
			this._eventEmitter.endDeferredEmit();
		}
	}

	private _changeDecorations<T>(ownerId: number, callback: (changeAccessor: editorCommon.IModelDecorationsChangeAccessor) => T): T {
		let changeAccessor: editorCommon.IModelDecorationsChangeAccessor = {
			addDecoration: (range: IRange, options: editorCommon.IModelDecorationOptions): string => {
				return this._deltaDecorationsImpl(ownerId, [], [{ range: range, options: options }])[0];
			},
			changeDecoration: (id: string, newRange: IRange): void => {
				this._changeDecorationImpl(id, newRange);
			},
			changeDecorationOptions: (id: string, options: editorCommon.IModelDecorationOptions) => {
				this._changeDecorationOptionsImpl(id, _normalizeOptions(options));
			},
			removeDecoration: (id: string): void => {
				this._deltaDecorationsImpl(ownerId, [id], []);
			},
			deltaDecorations: (oldDecorations: string[], newDecorations: editorCommon.IModelDeltaDecoration[]): string[] => {
				return this._deltaDecorationsImpl(ownerId, oldDecorations, newDecorations);
			}
		};
		let result: T = null;
		try {
			result = callback(changeAccessor);
		} catch (e) {
			onUnexpectedError(e);
		}
		// Invalidate change accessor
		changeAccessor.addDecoration = null;
		changeAccessor.changeDecoration = null;
		changeAccessor.removeDecoration = null;
		changeAccessor.deltaDecorations = null;
		return result;
	}

	public deltaDecorations(oldDecorations: string[], newDecorations: editorCommon.IModelDeltaDecoration[], ownerId: number = 0): string[] {
		this._assertNotDisposed();
		if (!oldDecorations) {
			oldDecorations = [];
		}

		try {
			this._eventEmitter.beginDeferredEmit();
			this._acquireDecorationsTracker();
			return this._deltaDecorationsImpl(ownerId, oldDecorations, newDecorations);
		} finally {
			this._releaseDecorationsTracker();
			this._eventEmitter.endDeferredEmit();
		}
	}

	_getTrackedRange(id: string): Range {
		return this.getDecorationRange(id);
	}

	_setTrackedRange(id: string, newRange: Range, newStickiness: editorCommon.TrackedRangeStickiness): string {
		const node = (id ? this._decorations[id] : null);

		if (!node) {
			if (!newRange) {
				// node doesn't exist, the request is to delete => nothing to do
				return null;
			}
			// node doesn't exist, the request is to set => add the tracked range
			return this._deltaDecorationsImpl(0, [], [{ range: newRange, options: TRACKED_RANGE_OPTIONS[newStickiness] }])[0];
		}

		if (!newRange) {
			// node exists, the request is to delete => delete node
			this._decorationsTree.delete(node);
			delete this._decorations[node.id];
			return null;
		}

		// node exists, the request is to set => change the tracked range and its options
		const range = this._validateRangeRelaxedNoAllocations(newRange);
		this._ensureLineStarts();
		const startOffset = this._lineStarts.getAccumulatedValue(range.startLineNumber - 2) + range.startColumn - 1;
		const endOffset = this._lineStarts.getAccumulatedValue(range.endLineNumber - 2) + range.endColumn - 1;
		this._decorationsTree.delete(node);
		node.reset(this.getVersionId(), startOffset, endOffset, range);
		node.setOptions(TRACKED_RANGE_OPTIONS[newStickiness]);
		this._decorationsTree.insert(node);
		return node.id;
	}

	public removeAllDecorationsWithOwnerId(ownerId: number): void {
		const nodes = this._decorationsTree.collectNodesFromOwner(ownerId);
		for (let i = 0, len = nodes.length; i < len; i++) {
			const node = nodes[i];

			this._decorationsTree.delete(node);
			delete this._decorations[node.id];
		}
	}

	public getDecorationOptions(decorationId: string): editorCommon.IModelDecorationOptions {
		const node = this._decorations[decorationId];
		if (!node) {
			return null;
		}
		return node.options;
	}

	public getDecorationRange(decorationId: string): Range {
		const node = this._decorations[decorationId];
		if (!node) {
			return null;
		}
		const versionId = this.getVersionId();
		if (node.cachedVersionId !== versionId) {
			this._decorationsTree.resolveNode(node, versionId);
		}
		if (node.range === null) {
			this._ensureLineStarts();
			node.range = this._getRangeAt(node.cachedAbsoluteStart, node.cachedAbsoluteEnd);
		}
		return node.range;
	}

	public getLineDecorations(lineNumber: number, ownerId: number = 0, filterOutValidation: boolean = false): editorCommon.IModelDecoration[] {
		if (lineNumber < 1 || lineNumber > this.getLineCount()) {
			return [];
		}

		return this.getLinesDecorations(lineNumber, lineNumber, ownerId, filterOutValidation);
	}

	public getLinesDecorations(_startLineNumber: number, _endLineNumber: number, ownerId: number = 0, filterOutValidation: boolean = false): editorCommon.IModelDecoration[] {
		let lineCount = this.getLineCount();
		let startLineNumber = Math.min(lineCount, Math.max(1, _startLineNumber));
		let endLineNumber = Math.min(lineCount, Math.max(1, _endLineNumber));
		let endColumn = this.getLineMaxColumn(endLineNumber);
		return this._getDecorationsInRange(new Range(startLineNumber, 1, endLineNumber, endColumn), ownerId, filterOutValidation);
	}

	public getDecorationsInRange(range: IRange, ownerId: number = 0, filterOutValidation: boolean = false): editorCommon.IModelDecoration[] {
		let validatedRange = this.validateRange(range);
		return this._getDecorationsInRange(validatedRange, ownerId, filterOutValidation);
	}

	public getOverviewRulerDecorations(ownerId: number = 0, filterOutValidation: boolean = false): editorCommon.IModelDecoration[] {
		const versionId = this.getVersionId();
		const result = this._decorationsTree.search(ownerId, filterOutValidation, true, versionId);
		return this._ensureNodesHaveRanges(result);
	}

	public getAllDecorations(ownerId: number = 0, filterOutValidation: boolean = false): editorCommon.IModelDecoration[] {
		const versionId = this.getVersionId();
		const result = this._decorationsTree.search(ownerId, filterOutValidation, false, versionId);
		return this._ensureNodesHaveRanges(result);
	}

	private _emitModelDecorationsChangedEvent(): void {
		if (!this._isDisposing) {
			let e: textModelEvents.IModelDecorationsChangedEvent = {};
			this._eventEmitter.emit(textModelEvents.TextModelEventType.ModelDecorationsChanged, e);
		}
	}

	private _getDecorationsInRange(filterRange: Range, filterOwnerId: number, filterOutValidation: boolean): IntervalNode[] {
		this._ensureLineStarts();

		const startOffset = this._lineStarts.getAccumulatedValue(filterRange.startLineNumber - 2) + filterRange.startColumn - 1;
		const endOffset = this._lineStarts.getAccumulatedValue(filterRange.endLineNumber - 2) + filterRange.endColumn - 1;

		const versionId = this.getVersionId();
		const result = this._decorationsTree.intervalSearch(startOffset, endOffset, filterOwnerId, filterOutValidation, versionId);

		return this._ensureNodesHaveRanges(result);
	}

	private _ensureNodesHaveRanges(nodes: IntervalNode[]): IntervalNode[] {
		this._ensureLineStarts();

		for (let i = 0, len = nodes.length; i < len; i++) {
			const node = nodes[i];
			if (node.range === null) {
				node.range = this._getRangeAt(node.cachedAbsoluteStart, node.cachedAbsoluteEnd);
			}
		}
		return nodes;
	}

	private _getRangeAt(start: number, end: number): Range {
		const startResult = this._lineStarts.getIndexOf(start);
		const startLineLength = this._lines[startResult.index].text.length;
		const startColumn = Math.min(startResult.remainder + 1, startLineLength + 1);

		const endResult = this._lineStarts.getIndexOf(end);
		const endLineLength = this._lines[endResult.index].text.length;
		const endColumn = Math.min(endResult.remainder + 1, endLineLength + 1);

		return new Range(startResult.index + 1, startColumn, endResult.index + 1, endColumn);
	}

	private _changeDecorationImpl(decorationId: string, _range: IRange): void {
		const node = this._decorations[decorationId];
		if (!node) {
			return;
		}
		this._ensureLineStarts();
		const range = this._validateRangeRelaxedNoAllocations(_range);
		const startOffset = this._lineStarts.getAccumulatedValue(range.startLineNumber - 2) + range.startColumn - 1;
		const endOffset = this._lineStarts.getAccumulatedValue(range.endLineNumber - 2) + range.endColumn - 1;

		this._decorationsTree.delete(node);
		node.reset(this.getVersionId(), startOffset, endOffset, range);
		this._decorationsTree.insert(node);
	}

	private _changeDecorationOptionsImpl(decorationId: string, options: ModelDecorationOptions): void {
		const node = this._decorations[decorationId];
		if (!node) {
			return;
		}

		node.setOptions(options);
	}

	private _deltaDecorationsImpl(ownerId: number, oldDecorationsIds: string[], newDecorations: editorCommon.IModelDeltaDecoration[]): string[] {
		this._ensureLineStarts();
		const versionId = this.getVersionId();

		const oldDecorationsLen = oldDecorationsIds.length;
		let oldDecorationIndex = 0;

		const newDecorationsLen = newDecorations.length;
		let newDecorationIndex = 0;

		let result = new Array<string>(newDecorationsLen);
		while (oldDecorationIndex < oldDecorationsLen || newDecorationIndex < newDecorationsLen) {

			let node: IntervalNode = null;

			if (oldDecorationIndex < oldDecorationsLen) {
				// (1) get ourselves an old node
				do {
					node = this._decorations[oldDecorationsIds[oldDecorationIndex++]];
				} while (!node && oldDecorationIndex < oldDecorationsLen);

				// (2) remove the node from the tree (if it exists)
				if (node) {
					this._decorationsTree.delete(node);
				}
			}

			if (newDecorationIndex < newDecorationsLen) {
				// (3) create a new node if necessary
				if (!node) {
					const internalDecorationId = (++this._lastDecorationId);
					const decorationId = `${this._instanceId};${internalDecorationId}`;
					node = new IntervalNode(decorationId, 0, 0);
					this._decorations[decorationId] = node;
				}

				// (4) initialize node
				const newDecoration = newDecorations[newDecorationIndex];
				const range = this._validateRangeRelaxedNoAllocations(newDecoration.range);
				const options = _normalizeOptions(newDecoration.options);
				const startOffset = this._lineStarts.getAccumulatedValue(range.startLineNumber - 2) + range.startColumn - 1;
				const endOffset = this._lineStarts.getAccumulatedValue(range.endLineNumber - 2) + range.endColumn - 1;

				node.ownerId = ownerId;
				node.reset(versionId, startOffset, endOffset, range);
				node.setOptions(options);

				this._decorationsTree.insert(node);

				result[newDecorationIndex] = node.id;

				newDecorationIndex++;
			} else {
				if (node) {
					delete this._decorations[node.id];
				}
			}
		}

		return result;
	}
}

function cleanClassName(className: string): string {
	return className.replace(/[^a-z0-9\-]/gi, ' ');
}

export class ModelDecorationOverviewRulerOptions implements editorCommon.IModelDecorationOverviewRulerOptions {
	readonly color: string | ThemeColor;
	readonly darkColor: string | ThemeColor;
	readonly hcColor: string | ThemeColor;
	readonly position: editorCommon.OverviewRulerLane;

	constructor(options: editorCommon.IModelDecorationOverviewRulerOptions) {
		this.color = strings.empty;
		this.darkColor = strings.empty;
		this.hcColor = strings.empty;
		this.position = editorCommon.OverviewRulerLane.Center;

		if (options && options.color) {
			this.color = options.color;
		}
		if (options && options.darkColor) {
			this.darkColor = options.darkColor;
			this.hcColor = options.darkColor;
		}
		if (options && options.hcColor) {
			this.hcColor = options.hcColor;
		}
		if (options && options.hasOwnProperty('position')) {
			this.position = options.position;
		}
	}

	public equals(other: ModelDecorationOverviewRulerOptions): boolean {
		return (
			this.color === other.color
			&& this.darkColor === other.darkColor
			&& this.hcColor === other.hcColor
			&& this.position === other.position
		);
	}
}

let lastStaticId = 0;

export class ModelDecorationOptions implements editorCommon.IModelDecorationOptions {

	public static EMPTY: ModelDecorationOptions;

	public static register(options: editorCommon.IModelDecorationOptions): ModelDecorationOptions {
		return new ModelDecorationOptions(++lastStaticId, options);
	}

	public static createDynamic(options: editorCommon.IModelDecorationOptions): ModelDecorationOptions {
		return new ModelDecorationOptions(0, options);
	}

	readonly staticId: number;
	readonly stickiness: editorCommon.TrackedRangeStickiness;
	readonly className: string;
	readonly hoverMessage: IMarkdownString | IMarkdownString[];
	readonly glyphMarginHoverMessage: IMarkdownString | IMarkdownString[];
	readonly isWholeLine: boolean;
	readonly showIfCollapsed: boolean;
	readonly overviewRuler: ModelDecorationOverviewRulerOptions;
	readonly glyphMarginClassName: string;
	readonly linesDecorationsClassName: string;
	readonly marginClassName: string;
	readonly inlineClassName: string;
	readonly beforeContentClassName: string;
	readonly afterContentClassName: string;

	private constructor(staticId: number, options: editorCommon.IModelDecorationOptions) {
		this.staticId = staticId;
		this.stickiness = options.stickiness || editorCommon.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges;
		this.className = options.className ? cleanClassName(options.className) : strings.empty;
		this.hoverMessage = options.hoverMessage || [];
		this.glyphMarginHoverMessage = options.glyphMarginHoverMessage || [];
		this.isWholeLine = options.isWholeLine || false;
		this.showIfCollapsed = options.showIfCollapsed || false;
		this.overviewRuler = new ModelDecorationOverviewRulerOptions(options.overviewRuler);
		this.glyphMarginClassName = options.glyphMarginClassName ? cleanClassName(options.glyphMarginClassName) : strings.empty;
		this.linesDecorationsClassName = options.linesDecorationsClassName ? cleanClassName(options.linesDecorationsClassName) : strings.empty;
		this.marginClassName = options.marginClassName ? cleanClassName(options.marginClassName) : strings.empty;
		this.inlineClassName = options.inlineClassName ? cleanClassName(options.inlineClassName) : strings.empty;
		this.beforeContentClassName = options.beforeContentClassName ? cleanClassName(options.beforeContentClassName) : strings.empty;
		this.afterContentClassName = options.afterContentClassName ? cleanClassName(options.afterContentClassName) : strings.empty;
	}

	public equals(other: ModelDecorationOptions): boolean {
		if (this.staticId > 0 || other.staticId > 0) {
			return this.staticId === other.staticId;
		}

		return (
			this.stickiness === other.stickiness
			&& this.className === other.className
			&& this.isWholeLine === other.isWholeLine
			&& this.showIfCollapsed === other.showIfCollapsed
			&& this.glyphMarginClassName === other.glyphMarginClassName
			&& this.linesDecorationsClassName === other.linesDecorationsClassName
			&& this.marginClassName === other.marginClassName
			&& this.inlineClassName === other.inlineClassName
			&& this.beforeContentClassName === other.beforeContentClassName
			&& this.afterContentClassName === other.afterContentClassName
			&& markedStringsEquals(this.hoverMessage, other.hoverMessage)
			&& markedStringsEquals(this.glyphMarginHoverMessage, other.glyphMarginHoverMessage)
			&& this.overviewRuler.equals(other.overviewRuler)
		);
	}
}
ModelDecorationOptions.EMPTY = ModelDecorationOptions.register({});

/**
 * The order carefully matches the values of the enum.
 */
const TRACKED_RANGE_OPTIONS = [
	ModelDecorationOptions.register({ stickiness: editorCommon.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges }),
	ModelDecorationOptions.register({ stickiness: editorCommon.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges }),
	ModelDecorationOptions.register({ stickiness: editorCommon.TrackedRangeStickiness.GrowsOnlyWhenTypingBefore }),
	ModelDecorationOptions.register({ stickiness: editorCommon.TrackedRangeStickiness.GrowsOnlyWhenTypingAfter }),
];

function _normalizeOptions(options: editorCommon.IModelDecorationOptions): ModelDecorationOptions {
	if (options instanceof ModelDecorationOptions) {
		return options;
	}
	return ModelDecorationOptions.createDynamic(options);
}
