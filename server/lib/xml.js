/** Minimal, safe RSS/Atom item extractor (regex based; never evaluates content). */
const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : ''; };
const attr = (xml, name, a) => { const m = xml.match(new RegExp(`<${name}\\b[^>]*\\b${a}="([^"]*)"`, 'i')); return m ? m[1] : ''; };

export function rssItems(xml, limit = 20) {
  const items = [];
  const re = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < limit) {
    const x = m[0];
    items.push({
      title: tag(x, 'title'),
      link: tag(x, 'link') || attr(x, 'link', 'href'),
      published: tag(x, 'pubDate') || tag(x, 'published') || tag(x, 'updated') || tag(x, 'dc:date'),
      source: tag(x, 'source') || attr(x, 'source', 'url'),
      summary: tag(x, 'description').slice(0, 300),
    });
  }
  return items;
}
