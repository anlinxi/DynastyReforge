/** MSG =b/=r/=0：仅颜色切换，不占字距或打字时间，颜色跨行/页延续。 */
export function dialoguePages(source = '', maxLines = 4) {
  const pages = [{ text: '', styles: [] }];
  let style = 'normal', lines = 1;
  const text = source.replace(/\u0001/g, '\n');
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '=' && 'br0'.includes(text[i + 1] ?? '\0')) {
      style = { b: 'blue', r: 'red', 0: 'normal' }[text[++i]];
      continue;
    }
    if (text[i] === '\n' && ++lines > maxLines) {
      pages.push({ text: '', styles: [] });
      lines = 1;
      continue;
    }
    const page = pages.at(-1);
    page.text += text[i];
    page.styles.push(style);
  }
  return pages;
}

/** 三层使用原字距：被另一种颜色绘制的字以等宽空白占位。 */
export function dialogueLayer(page, style, count = page.text.length) {
  return [...page.text.slice(0, count)].map((c, i) => (
    c === '\n' || page.styles[i] === style ? c : c.charCodeAt(0) < 128 ? ' ' : '　'
  )).join('');
}
