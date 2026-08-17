import { describe, expect, it } from 'vitest';
import { cacheFileName, documentDetail, documentType } from './document-name.ts';

describe('documentType', () => {
  it('is the extension, uppercased', () => {
    expect(documentType('Route_map_Saturday.pdf')).toBe('PDF');
    expect(documentType('roster.XLSX')).toBe('XLSX');
  });

  it('reads the LAST extension, not the first', () => {
    expect(documentType('summer.2026.results.csv')).toBe('CSV');
  });

  it('is null when there is nothing to read', () => {
    expect(documentType(null)).toBeNull();
    expect(documentType('')).toBeNull();
    expect(documentType('README')).toBeNull();
    // A trailing dot is not an extension, and neither is a run of them.
    expect(documentType('notes.')).toBeNull();
  });

  it('does not mistake a dotted name for an extension', () => {
    // Nine characters after the dot is longer than any real extension, so this is a name with a
    // full stop in it rather than a file type.
    expect(documentType('minutes.september')).toBeNull();
  });
});

describe('documentDetail', () => {
  it('joins the type and the size', () => {
    expect(documentDetail('Route_map_Saturday.pdf', 1_258_291)).toBe('PDF · 1.2 MB');
  });

  it('shows whichever half exists', () => {
    expect(documentDetail('Route_map_Saturday.pdf', null)).toBe('PDF');
    expect(documentDetail('README', 2048)).toBe('2.0 KB');
  });

  it('is null when neither does', () => {
    expect(documentDetail(null, null)).toBeNull();
  });
});

describe('cacheFileName', () => {
  it('keeps the name the sender saw', () => {
    expect(cacheFileName('Route map - Saturday.pdf', 'application/pdf')).toBe(
      'Route map - Saturday.pdf',
    );
    // Accents survive: the share sheet is showing this to a person.
    expect(cacheFileName('Itinéraire.pdf', 'application/pdf')).toBe('Itinéraire.pdf');
  });

  it('cannot climb out of the directory it is written into', () => {
    // Every separator becomes an underscore, so the whole path collapses into one flat name -
    // and `passwd` carries no extension, so the mime supplies one.
    expect(cacheFileName('../../etc/passwd', 'text/plain')).toBe('.._.._etc_passwd.txt');
    expect(cacheFileName('..', 'text/plain')).toBe('document.txt');
    expect(cacheFileName('.', 'text/plain')).toBe('document.txt');
    expect(cacheFileName('a/b.pdf', 'application/pdf')).toBe('a_b.pdf');
    expect(cacheFileName('a\\b.pdf', 'application/pdf')).toBe('a_b.pdf');
  });

  it('replaces rather than removes, so two names cannot become one file', () => {
    expect(cacheFileName('a/b.txt', 'text/plain')).not.toBe(
      cacheFileName('ab.txt', 'text/plain'),
    );
  });

  it('adds an extension only when the name has none', () => {
    expect(cacheFileName('roster', 'text/csv')).toBe('roster.csv');
    // Already carries one, and it is the sender's rather than the mime's opinion that counts.
    expect(cacheFileName('roster.csv', 'text/plain')).toBe('roster.csv');
  });

  it('names an unnamed document, and leaves an unknown type unextended', () => {
    expect(cacheFileName(null, 'application/pdf')).toBe('document.pdf');
    expect(cacheFileName('', 'application/pdf')).toBe('document.pdf');
    expect(cacheFileName('mystery', 'application/octet-stream')).toBe('mystery');
  });
});
