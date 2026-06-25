export function generateSlug(title) {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

export function getExcerpt(text, maxLength = 200) {
  return text.replace(/[#*`>\[\]()]/g, '').substring(0, maxLength).trim();
}

export function countWords(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function readingTimeMinutes(wordCount) {
  return Math.max(1, Math.ceil(wordCount / 200));
}

export function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function calculateNextOccurrence(from, interval, unit) {
  const date = new Date(from);
  switch (unit) {
    case 'minutes': date.setMinutes(date.getMinutes() + interval); break;
    case 'hours': date.setHours(date.getHours() + interval); break;
    case 'days': date.setDate(date.getDate() + interval); break;
    case 'weeks': date.setDate(date.getDate() + (interval * 7)); break;
    case 'months': date.setMonth(date.getMonth() + interval); break;
  }
  return date;
}

export function getDayHashtags(date) {
  const templates = [
    '#Sunday #Reading', '#Monday #NewWeek #Motivation', '#Tuesday #Coffee',
    '#Wednesday #KeepGoing', '#Thursday #AlmostThere', '#Friday #Weekend',
    '#Saturday #Relax #Reading'
  ];
  return templates[date.getDay()];
}

export function processHashtags(template) {
  if (!template) return '';
  const today = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return template.replace('{day}', dayNames[today.getDay()]).replace('{date}', today.toLocaleDateString('en-US')).substring(0, 100);
}

export function parseFrontmatter(md) {
  const match = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: md };
  const frontmatter = {};
  match[1].split('\n').forEach(line => {
    const i = line.indexOf(':');
    if (i === -1) return;
    const key = line.substring(0, i).trim();
    let value = line.substring(i + 1).trim().replace(/^["']|["']$/g, '');
    if (value.startsWith('[') && value.endsWith(']')) try { value = JSON.parse(value); } catch {}
    frontmatter[key] = value;
  });
  return { frontmatter, body: match[2].trim() };
}

export function getCookie(request, name) {
  const s = request.headers.get('Cookie');
  if (!s) return null;
  for (const c of s.split(';')) {
    const [k, v] = c.trim().split('=');
    if (k === name) return v;
  }
  return null;
}