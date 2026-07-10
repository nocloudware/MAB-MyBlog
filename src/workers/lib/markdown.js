export function markdownToHTML(md) {
  let html = md;

  // Escapar HTML
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Bloques de código (```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
  });

  // Código inline (`)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Tablas
  html = html.replace(/^\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)*)/gm, (match, header, rows) => {
    const headers = header.split('|').map(h => h.trim()).filter(Boolean);
    const headerHTML = '<tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr>';
    const rowsHTML = rows.trim().split('\n').map(row => {
      const cells = row.split('|').map(c => c.trim()).filter(Boolean);
      return '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
    }).join('');
    return `<table>${headerHTML}${rowsHTML}</table>`;
  });

  // Encabezados
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Línea horizontal
  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/^\*\*\*$/gm, '<hr>');
  html = html.replace(/^___$/gm, '<hr>');

  // Negrita, itálica, tachado
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Enlaces e imágenes
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

  // Citas
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/<\/blockquote>\n<blockquote>/g, '<br>');

  // Listas no ordenadas
  html = html.replace(/^[\*\-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Listas ordenadas
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Solo convertir en <ol> los bloques que no fueron ya convertidos en <ul>
  html = html.replace(/<li>.*<\/li>/g, (match) => {
    if (!match.includes('<ul>')) return match;
    return match;
  });

  // Checkboxes
  html = html.replace(/<li>\[ \] (.+)<\/li>/g, '<li><input type="checkbox" disabled> $1</li>');
  html = html.replace(/<li>\[x\] (.+)<\/li>/g, '<li><input type="checkbox" checked disabled> $1</li>');
  html = html.replace(/<li>\[X\] (.+)<\/li>/g, '<li><input type="checkbox" checked disabled> $1</li>');

  // Párrafos
  html = html.replace(/^(?!<[a-z/!]).+(?!<\/[a-z]>)$/gm, '<p>$&</p>');

  // Limpiar saltos extra
  html = html.replace(/\n\n/g, '\n');

  // Estilos para tablas
  html = `<style>
    table { border-collapse: collapse; width: 100%; margin: 1.5rem 0; }
    th, td { border: 1px solid #2a2a3e; padding: .5rem .75rem; text-align: left; }
    th { background: #1a1a2e; font-weight: 600; }
    tr:nth-child(even) { background: rgba(255,255,255,0.02); }
    input[type="checkbox"] { margin-right: .5rem; }
  </style>\n${html}`;

  return html;
}