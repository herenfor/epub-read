import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseHTML } from 'linkedom';
import { ArchiveReferences, detectArchiveReferences, validArchiveEntryKey } from './archiveReferences';
import { disposeBook, loadBook, loadBookFromArchive, spineIndexForEntryKey, spineIndexForPath, spineItemPath } from './book';
import { SyncArchiveClient } from './selectiveArchive';
import { parseLocator, parseNoteValue, parsePortableStateV3 } from './portableState/parser';
import { emptyOrganization } from '../ui/libraryOrganization';
import { ChapterDependencies } from '../render/chapterDependencies';
import { sanitizeChapter } from '../render/sanitize';
import { DEFAULT_SETTINGS } from '../render/settings';
import { buildEpub } from '../test/fixtures';

const chapter = 'OEBPS/Text/a?b#c%20.xhtml';
const css = 'OEBPS/Styles/s?x%.css';
const importedCss = 'OEBPS/Styles/nested%20.css';
const picture = 'OEBPS/Images/i?x#y%20.svg';
const font = 'OEBPS/Fonts/f?%20.ttf';
const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="../Styles/${encode(css.split('/').pop()!)}"/></head><body><p id="sec">正文</p><img src="../Images/${encode(picture.split('/').pop()!)}"/><svg xmlns="http://www.w3.org/2000/svg"><image href="../Images/${encode(picture.split('/').pop()!)}#shape"/></svg></body></html>`;
function fixture(): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const add = (name: string, text: string) => { files[name] = strToU8(text); };
  add('mimetype', 'application/epub+zip');
  add('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>');
  const manifest = [
    ['c', chapter, 'application/xhtml+xml', ''],
    ['nav', 'OEBPS/nav?%.xhtml', 'application/xhtml+xml', 'nav'],
    ['css', css, 'text/css', ''], ['nested', importedCss, 'text/css', ''],
    ['pic', picture, 'image/svg+xml', 'cover-image'], ['font', font, 'font/ttf', ''],
  ].map(([id, path, type, properties]) => `<item id="${id}" href="${encode(path.slice(6))}" media-type="${type}" properties="${properties}"/>`).join('');
  add('OEBPS/book.opf', `<package version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:test:names</dc:identifier><dc:title>Names</dc:title></metadata><manifest>${manifest}</manifest><spine><itemref idref="c"/></spine></package>`);
  add('OEBPS/nav?%.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="${encode(chapter.slice(6))}">Chapter</a><ol><li><a href="${encode(chapter.slice(6))}#sec">Section</a></li></ol></li></ol></nav></body></html>`);
  add(chapter, markup);
  add(css, `@import "${encode(importedCss.split('/').pop()!)}";body{background:url('../Images/${encode(picture.split('/').pop()!)}');margin:2em}`);
  add(importedCss, `@font-face{font-family:test;src:url('../Fonts/${encode(font.split('/').pop()!)}')}.box{padding:1em}`);
  add(picture, '<svg xmlns="http://www.w3.org/2000/svg"><path id="shape"/></svg>');
  add(font, 'test font bytes');
  return zipSync(files);
}

describe('archive entry identity compatibility', () => {
  it('detects actual ZIP names only; decoded base and encoded percent names remain distinct', () => {
    expect(detectArchiveReferences(new Map([['OEBPS/ch.xhtml', 0], ['OEBPS/a*:|.png', 0]]))).toBeUndefined();
    const directory = new Map([[chapter, 0], ['OEBPS/Text/%20.xhtml', 0], ['OEBPS/Text/ .xhtml', 0]]);
    const refs = detectArchiveReferences(directory)!;
    expect(refs.resolve(chapter, '#sec')).toEqual({ path: chapter, anchor: 'sec' });
    expect(refs.resolve(chapter, '%2520.xhtml?query#s%23x')).toEqual({ path: 'OEBPS/Text/%20.xhtml', anchor: 's#x' });
    expect(refs.resolve(chapter, '%20.xhtml').path).toBe('OEBPS/Text/ .xhtml');
    expect(refs.resolve('OEBPS/Text/base%20.xhtml', refs.href(chapter, 's#x'))).toEqual({ path: chapter, anchor: 's#x' });
    expect(refs.resolve(chapter, 'missing.xhtml').path).toBe('OEBPS/Text/missing.xhtml');
  });

  it('rejects external hrefs and root escapes without treating legal raw names as URLs', () => {
    const refs = new ArchiveReferences(new Map([[chapter, 0]]));
    for (const href of ['../../../Text/a.xhtml', 'file:///tmp/a', 'https://example.com/a', '//host/a']) {
      expect(refs.resolve(chapter, href).path).toBe('');
    }
    for (const key of [chapter, 'Text/*?:|.xhtml', 'Text/%2e%2e.xhtml', 'Text/%00.xhtml']) expect(validArchiveEntryKey(key)).toBe(true);
    for (const key of ['', '/a', 'C:/a', 'a\\b', 'a/../b', 'a//b', 'a/./b', 'a/\0b']) expect(validArchiveEntryKey(key)).toBe(false);
  });

  it.each(['eager', 'selective', 'native-bootstrap'] as const)('%s loader preserves exact resources and nested TOC identities', async mode => {
    const bytes = fixture();
    const book = mode === 'native-bootstrap' ? await loadBookFromArchive(new SyncArchiveClient(bytes))
      : await loadBook(bytes, { selective: mode === 'selective' });
    try {
      expect(book.archiveReferences).toBeDefined();
      expect(spineItemPath(book, 0)).toBe(chapter);
      expect(book.coverHref).toBe(picture);
      expect(book.resources.has(css)).toBe(true);
      expect(book.toc[0].disabled).toBeUndefined();
      expect(book.toc[0].children[0]).toMatchObject({ href: book.archiveReferences!.href(chapter, 'sec'), disabled: undefined });
      expect(spineIndexForPath(book, book.toc[0].children[0].href)).toBe(0);
      expect(spineIndexForEntryKey(book, chapter)).toBe(0);
      await book.ensureResources?.([chapter, css, importedCss, picture, font]);
      expect(new TextDecoder().decode(book.resources.get(chapter)!.data)).toBe(markup);
      const deps = new ChapterDependencies(book, p => {
        const bytes = book.resources.get(p)?.data;
        return bytes ? new TextDecoder().decode(bytes) : undefined;
      });
      const closure = await deps.collect(chapter);
      expect([...closure]).toEqual(expect.arrayContaining([chapter, css, importedCss, picture, font]));
      const styles: string[] = [];
      const result = await sanitizeChapter(markup, {
        basePath: chapter, archiveReferences: book.archiveReferences, strictXml: true, settings: DEFAULT_SETTINGS,
        urlFor: p => book.resources.has(p) ? `blob:test/${encode(p)}` : undefined,
        getText: p => { const data = book.resources.get(p)?.data; return data ? new TextDecoder().decode(data) : undefined; },
        makeUrl: text => { styles.push(text); return 'blob:css'; },
      });
      expect(result.issues).toEqual([]);
      const doc = parseHTML(result.html).document;
      expect(doc.querySelector('img')!.getAttribute('src')).toBe(`blob:test/${encode(picture)}`);
      expect(doc.querySelector('image')!.getAttribute('href')).toBe(`blob:test/${encode(picture)}#shape`);
      expect(styles.join('')).toContain(`blob:test/${encode(picture)}`);
      expect(styles.join('')).toContain(`blob:test/${encode(font)}`);
      expect(styles.join('')).toContain('padding:1em');
    } finally { disposeBook(book); }
    expect(book.archiveReferences).toBeUndefined();
  });

  it('ordinary books retain the legacy resolver and unchanged author styles', async () => {
    const content = '<html><head><style>.box{padding:1em;color:red}</style></head><body><p class="box">正文</p></body></html>';
    const book = await loadBook(await buildEpub({ version: 3, chapters: [{ id: 'c', href: 'ch.xhtml', content }] }));
    try {
      expect(book.archiveReferences).toBeUndefined();
      expect(spineItemPath(book, 0)).toBe('OEBPS/ch.xhtml');
      expect(spineIndexForPath(book, book.toc[0].href)).toBe(0);
      const options = { basePath: 'OEBPS/ch.xhtml', strictXml: true, settings: DEFAULT_SETTINGS, urlFor: () => undefined };
      const old = await sanitizeChapter(content, options);
      const gated = await sanitizeChapter(content, { ...options, archiveReferences: book.archiveReferences });
      expect(gated).toEqual(old);
      expect(gated.html).toContain('.box{padding:1em;color:red}');
    } finally { disposeBook(book); }
  });

  it('roundtrips raw special names through progress, bookmark and note wire values', () => {
    const locator = { locatorVersion: 1, chapterPath: chapter, spineIndexHint: 0, target: { kind: 'chapter-start' } };
    expect(parseLocator(locator)).toEqual(locator);
    const note = { chapterPath: chapter, spineIndexHint: 0, textProfile: 'visible-codepoints-no-whitespace-v1', startTextOffset: 0, endTextOffset: 2, startTextSnippet: '正文', endTextSnippet: '正文', selectedText: '正文', content: 'note', createdAtMs: 1 };
    expect(parseNoteValue(note)).toEqual(note);
    const stamp = { deviceId: '00000000-0000-4000-8000-000000000001', counter: 1 };
    const version = (value: unknown) => ({ stamp, clock: { [stamp.deviceId]: 1 }, value, updatedAtMs: 1 });
    const state = { schemaVersion: 3, organization: emptyOrganization(), books: { ['a'.repeat(64)]: {
      metadata: { value: { title: 'Book', creator: 'Author', fileName: 'book.epub', addedAtMs: 1 }, stamp },
      progress: { versions: [version({ locator, progressPctHint: 25 })] },
      bookmarks: { [stamp.deviceId]: { versions: [version({ locator, text: 'bookmark', createdAtMs: 1 })] } }, notes: { [stamp.deviceId]: { versions: [version(note)] } },
    } } };
    const parsed = parsePortableStateV3(JSON.parse(JSON.stringify(state)));
    expect(parsed.books['a'.repeat(64)].progress.versions[0].value!.locator).toEqual(locator);
    expect(parsed.books['a'.repeat(64)].bookmarks[stamp.deviceId].versions[0].value.locator).toEqual(locator);
    expect(parsed.books['a'.repeat(64)].notes[stamp.deviceId].versions[0].value).toEqual(note);
  });
});
