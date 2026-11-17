'use strict';

const { jsPDF } = require('jspdf');
const {
  formatScorePair,
  formatPercentage,
  formatDuration,
  formatInvitedOn,
} = require('./format');

function buildResultPdf(result) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setFillColor(4, 30, 48);
  doc.rect(0, 0, pageWidth, 72, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('GuideXpert', 48, 32);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text('JEE Main Mock Test Result', 48, 52);

  doc.setTextColor(4, 30, 48);
  let y = 112;
  const rows = [
    ['Student', result.studentName || 'Not available'],
    ['Invited on', formatInvitedOn(result.invitedOn)],
    ['Attempt status', 'Attempted'],
    ['Overall marks', formatScorePair(result.overall && result.overall.obtained, result.overall && result.overall.total)],
    ['Percentage', formatPercentage(result.overall && result.overall.percentage) || 'Not available'],
    ['MCQ marks', formatScorePair(result.mcq && result.mcq.obtained, result.mcq && result.mcq.total)],
    ['MCQ time', formatDuration(result.mcq && result.mcq.durationMinutes)],
    ['Numerical marks', formatScorePair(result.numerical && result.numerical.obtained, result.numerical && result.numerical.total)],
    ['Numerical time', formatDuration(result.numerical && result.numerical.durationMinutes)],
    ['Time spent', formatDuration(result.overall && result.overall.durationMinutes)],
    ['Allotted time', formatDuration(result.overall && result.overall.allottedMinutes)],
  ];

  rows.forEach(([label, value], index) => {
    if (index % 2 === 0) {
      doc.setFillColor(245, 247, 250);
      doc.rect(40, y - 16, pageWidth - 80, 28, 'F');
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(4, 30, 48);
    doc.text(label, 52, y);
    doc.setFont('helvetica', 'normal');
    doc.text(String(value), 210, y);
    y += 28;
  });

  doc.setFontSize(9);
  doc.setTextColor(90, 101, 112);
  doc.text('This report contains only the verified mock test record for this session.', 48, y + 18);
  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { buildResultPdf };
