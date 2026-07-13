const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');

const ROOT = path.resolve(__dirname, '..');
const mdPath = path.join(ROOT, 'USER_MANUAL.md');
const outPath = path.join(ROOT, 'USER_MANUAL_styled.docx');

if (!fs.existsSync(mdPath)) {
  console.error('Markdown file not found:', mdPath);
  process.exit(1);
}

const lines = fs.readFileSync(mdPath, 'utf8').split(/\r?\n/);

const baseStyles = {
  paragraphStyles: [
    {
      id: 'NormalText',
      name: 'Normal Text',
      basedOn: 'Normal',
      next: 'Normal',
    },
  ],
};

// Cover
const title = new Paragraph({
  children: [new TextRun({ text: 'NEXA POS System User Manual', bold: true, size: 56 })],
  heading: HeadingLevel.TITLE,
  alignment: 'center',
});
const subtitle = new Paragraph({
  children: [new TextRun({ text: 'User Guide and Operational Manual', size: 24 })],
  alignment: 'center',
});
const date = new Paragraph({
  children: [new TextRun({ text: new Date().toLocaleDateString(), italics: true, size: 20 })],
  alignment: 'center',
});

// Cover children (we'll build final document sections later)
const coverChildren = [title, subtitle, date, new Paragraph({ children: [], pageBreakBefore: true })];

// New section for content
const content = [];
let i = 0;
const n = lines.length;

function pushParagraph(text) {
  content.push(new Paragraph(text));
}

while (i < n) {
  let line = lines[i].trim();
  if (!line) { i++; continue; }
  if (line.startsWith('#')) {
    const level = line.match(/^#+/)[0].length;
    const text = line.replace(/^#+/, '').trim();
    if (level === 1) content.push(new Paragraph({ text, heading: HeadingLevel.HEADING_1 }));
    else if (level === 2) content.push(new Paragraph({ text, heading: HeadingLevel.HEADING_2 }));
    else content.push(new Paragraph({ text, heading: HeadingLevel.HEADING_3 }));
    i++;
    continue;
  }
  if (line.startsWith('---')) {
    content.push(new Paragraph({ children: [], pageBreakBefore: true }));
    i++; continue;
  }
  if (line.startsWith('- ')) {
    while (i < n && lines[i].trim().startsWith('- ')) {
      const item = lines[i].trim().slice(2).trim();
      const p = new Paragraph({ text: item, bullet: { level: 0 } });
      content.push(p);
      i++;
    }
    continue;
  }
  const numMatch = line.match(/^\d+\.\s+/);
  if (numMatch) {
    while (i < n && lines[i].trim().match(/^\d+\.\s+/)) {
      const item = lines[i].trim().replace(/^\d+\.\s+/, '');
      const p = new Paragraph({ text: item });
      content.push(p);
      i++;
    }
    continue;
  }
  const paraLines = [lines[i]];
  i++;
  while (i < n && lines[i].trim() !== '') { paraLines.push(lines[i]); i++; }
  const text = paraLines.join('\n').replace(/\*\*/g, '').replace(/\*/g, '');
  content.push(new Paragraph(text));
}

// Build final document with sections
const finalDoc = new Document({ sections: [
  { children: coverChildren },
  { children: content },
], styles: baseStyles });

Packer.toBuffer(finalDoc).then((buffer) => {
  fs.writeFileSync(outPath, buffer);
  console.log('Saved:', outPath);
}).catch((err) => {
  console.error('Error packing docx:', err);
  process.exit(2);
});
