import { marked } from 'https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js';

export function renderPreview(markdown) {
    return marked.parse(markdown);
}