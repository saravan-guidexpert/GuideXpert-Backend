'use strict';

const fs = require('fs');
const path = require('path');
const { jsPDF } = require('jspdf');
const {
  formatScorePair,
  formatPercentage,
  formatDuration,
  formatInvitedOn,
} = require('./format');

// Same wordmark as the admin sidebar:
// https://res.cloudinary.com/dfqdb1xws/image/upload/v1773394005/GuideXpert_Logo_inbaz5.png
const LOGO = fs.readFileSync(path.join(__dirname, 'guidexpert-logo.png'));
const LOGO_ASPECT = 995 / 232;

function buildResultPdf(result) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const headerHeight = 78;
  doc.setFillColor(4, 30, 48);
  doc.rect(0, 0, pageWidth, headerHeight, 'F');
  const logoHeight = 26;
  const logoWidth = logoHeight * LOGO_ASPECT;
  doc.addImage(LOGO, 'PNG', 48, 12, logoWidth, logoHeight, 'guidexpert-logo', 'SLOW');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text('JEE Main Mock Test Result', 48, 58);

  doc.setTextColor(4, 30, 48);
  let y = headerHeight + 40;
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
