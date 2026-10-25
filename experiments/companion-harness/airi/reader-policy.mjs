export const READER_READ_TOOLS = new Set(['reader_find_books', 'reader_get_book', 'reader_list_chapters',
  'reader_read_passages', 'reader_search_text', 'reader_get_index_status']);

export function selectReaderTools(catalog) {
  return catalog.filter(tool => READER_READ_TOOLS.has(tool.name) && tool.readOnly === true);
}
