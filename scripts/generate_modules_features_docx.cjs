const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, HeadingLevel, TextRun, AlignmentType, Footer, PageNumber } = require('docx');

const root = path.resolve(__dirname, '..');
const input = path.join(root, 'MODULES_AND_FEATURES.md');
const output = path.join(root, 'NEXA_POS_Modules_and_Features.docx');
const lines = fs.readFileSync(input, 'utf8').split(/\r?\n/);
const children = [];

for (const raw of lines) {
  const line = raw.trim();
  if (!line) continue;
  if (line === '# NEXA POS System') {
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 180 }, children: [new TextRun({ text: line.slice(2), bold: true, size: 44, color: '17365D' })] }));
  } else if (line === '## Modules and Features Inventory') {
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 420 }, children: [new TextRun({ text: line.slice(3), size: 28, color: '5B6573' })] }));
  } else if (line.startsWith('## ')) {
    children.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_1, pageBreakBefore: line === '## List of Features' }));
  } else if (line.startsWith('### ')) {
    children.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 100 } }));
  } else if (/^\d+\.\s/.test(line)) {
    children.push(new Paragraph({ text: line.replace(/^\d+\.\s*/, ''), numbering: { reference: 'modules', level: 0 }, spacing: { after: 70 } }));
  } else if (line.startsWith('- ')) {
    children.push(new Paragraph({ text: line.slice(2), bullet: { level: 0 }, spacing: { after: 55 } }));
  }
}

const doc = new Document({
  numbering: { config: [{ reference: 'modules', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },
  styles: { default: { document: { run: { font: 'Aptos', size: 22 }, paragraph: { spacing: { line: 276 } } } } },
  sections: [{
    properties: { page: { margin: { top: 900, right: 900, bottom: 900, left: 900 } } },
    children,
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'NEXA POS System  |  ' }), new TextRun({ children: [PageNumber.CURRENT] })] })] }) }
  }]
});

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync(output, buffer);
  console.log(output);
});
