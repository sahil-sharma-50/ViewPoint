export function githubFileUrl(repoUrl: string, file: string): string | undefined {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/?$/.test(repoUrl) ||
      file.split('/').some(part => !part || part === '.' || part === '..')) return undefined;
  return `${repoUrl.replace(/\/$/, '')}/blob/HEAD/${file.split('/').map(encodeURIComponent).join('/')}`;
}

export function evidenceParts(text: string, files: ReadonlySet<string>): { text: string; file?: string }[] {
  const arrow = text.split(' → ');
  if (arrow.length === 2 && files.has(arrow[0]!) && files.has(arrow[1]!)) {
    return [{ text: arrow[0]!, file: arrow[0]! }, { text: ' → ' }, { text: arrow[1]!, file: arrow[1]! }];
  }
  const label = text.startsWith('Source excerpt: ') ? 'Source excerpt: ' : '';
  const separator = label ? ', first 60 lines.' : ': ';
  const end = text.indexOf(separator, label.length);
  const file = text.slice(label.length, end);
  if (end !== -1 && files.has(file)) {
    return [...(label ? [{ text: label }] : []), { text: file, file }, { text: text.slice(end) }];
  }
  return [{ text }];
}
