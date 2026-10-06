import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderText,
  tooltips,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { yaml } from '@codemirror/lang-yaml';
import { linter, lintGutter } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import { clsx } from 'clsx';
import { parseDocument } from 'yaml';

// Syntax colors lean toward the host text color so they stay legible on light and dark themes.
const tint = (color: string) => `color-mix(in srgb, ${color} 75%, var(--mh-text))`;
const highlight = HighlightStyle.define([
  { tag: tags.definition(tags.propertyName), color: tint('#0a84ff') },
  { tag: [tags.string, tags.special(tags.string)], color: tint('#30d158') },
  { tag: [tags.labelName, tags.typeName], color: tint('#bf5af2') },
  { tag: tags.lineComment, color: 'var(--mh-muted)', fontStyle: 'italic' },
  { tag: [tags.separator, tags.punctuation, tags.squareBracket, tags.brace, tags.meta], color: 'var(--mh-muted)' },
]);

const theme = EditorView.theme({
  '&': { color: 'inherit', backgroundColor: 'transparent', fontSize: 'inherit' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.6',
    minHeight: '9rem',
    maxHeight: '22rem',
  },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--mh-text)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--mh-text)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--mh-muted)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 10px', minWidth: '2.5ch' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--mh-fill)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, #0a84ff 35%, transparent)',
  },
  '.cm-placeholder': { color: 'var(--mh-muted)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--mh-fill-strong)', outline: 'none' },
  '.cm-tooltip': {
    backgroundColor: 'var(--mh-popup)',
    color: 'var(--mh-text)',
    border: '1px solid var(--mh-line)',
    borderRadius: '10px',
    overflow: 'hidden',
  },
});

// YAML syntax errors as reported by the `yaml` parser itself, at its own positions.
const syntaxLint = linter((view) => {
  const text = view.state.doc.toString();
  return parseDocument(text, { prettyErrors: false }).errors.map((error) => ({
    from: Math.min(error.pos[0], text.length),
    to: Math.min(error.pos[1], text.length),
    severity: 'error' as const,
    message: error.message,
  }));
});

/** CodeMirror YAML editor driven like a controlled input. */
export function YamlEditor({
  id,
  value,
  onChange,
  onBlur,
  label,
  describedBy,
  placeholder,
  invalid,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  label: string;
  describedBy: string;
  placeholder: string;
  invalid: boolean;
  disabled: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const callbacks = useRef({ onChange, onBlur });
  callbacks.current = { onChange, onBlur };
  const [settings] = useState(() => new Compartment());
  const dynamic = () => [
    EditorView.contentAttributes.of({
      id,
      'aria-label': label,
      'aria-describedby': describedBy,
      'aria-invalid': String(invalid),
    }),
    EditorView.editable.of(!disabled),
    EditorState.readOnly.of(disabled),
  ];

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          indentUnit.of('  '),
          EditorState.tabSize.of(2),
          EditorView.lineWrapping,
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          yaml(),
          syntaxHighlighting(highlight),
          syntaxLint,
          lintGutter(),
          // Fixed tooltips inside the plugin's container query would be positioned against it.
          tooltips({ parent: document.getElementById('mihomoctl-portals') ?? undefined }),
          placeholderText(placeholder),
          theme,
          settings.of(dynamic()),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
            if (update.focusChanged && !update.view.hasFocus) callbacks.current.onBlur();
          }),
        ],
      }),
    });
    view.current = editor;
    return () => editor.destroy();
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: settings.reconfigure(dynamic()) });
  }, [id, label, describedBy, invalid, disabled]);

  // Form resets, restores and device reloads replace the document from outside.
  useEffect(() => {
    const editor = view.current;
    const current = editor?.state.doc.toString();
    if (editor && current !== value)
      editor.dispatch({ changes: { from: 0, to: current!.length, insert: value } });
  }, [value]);

  return (
    <div
      ref={host}
      data-yaml-editor
      className={clsx(
        'ufi:overflow-hidden ufi:rounded-xl ufi:border ufi:border-solid ufi:bg-[var(--mh-fill)] ufi:text-sm ufi:transition-colors ufi:pointer-coarse:text-base ufi:focus-within:border-[var(--mh-accent)]',
        invalid ? 'ufi:border-[#ff6961]' : 'ufi:border-[var(--mh-line)]',
        disabled && 'ufi:opacity-40',
      )}
    />
  );
}
