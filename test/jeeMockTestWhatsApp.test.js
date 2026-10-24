'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveJeeMockTestTemplate,
  resolveJeeMockTestHeaderImageUrl,
  buildJeeMockTestSubmitVars,
  JEE_MOCK_TEST_HEADER_IMAGE_URL,
  JEE_MOCK_TEST_INFLUENCER_TEMPLATE_ID,
  JEE_MOCK_TEST_DIRECT_TEMPLATE_ID,
  JEE_MOCK_TEST_MESSAGE_KIND,
  JEE_MOCK_TEST_UTM_TEMPLATES,
} = require('../utils/jeeMockTestWhatsApp');
const { getTemplateMetaForKind } = require('../utils/whatsappTemplateMeta');
const { validateMessageKindForOpsProduct } = require('../utils/whatsappOpsEventMatch');
const { parseOpsProductQuery, matchWhatsAppEventsByOpsProduct } = require('../utils/whatsappOpsProduct');
const WhatsAppRetryGroup = require('../models/WhatsAppRetryGroup');
const WhatsAppMessageEvent = require('../models/WhatsAppMessageEvent');

describe('jee mock test UTM templates', () => {
  test('listed influencer links use the template for that link', () => {
    assert.equal(JEE_MOCK_TEST_UTM_TEMPLATES.length, 8);
    const directContents = new Set(['referp', 'pro']);
    for (const row of JEE_MOCK_TEST_UTM_TEMPLATES) {
      const match = resolveJeeMockTestTemplate(row);
      assert.ok(match);
      assert.equal(match.messageKind, JEE_MOCK_TEST_MESSAGE_KIND);
      const expected = directContents.has(String(row.utm_content).toLowerCase())
        ? JEE_MOCK_TEST_DIRECT_TEMPLATE_ID
        : JEE_MOCK_TEST_INFLUENCER_TEMPLATE_ID;
      assert.equal(match.templateId, expected);
    }
  });

  test('referp, PRO, and a direct visit use the direct template', () => {
    const referp = resolveJeeMockTestTemplate({
      utm_source: 'instagram',
      utm_medium: 'influencer',
      utm_campaign: 'guide_xperts',
      utm_content: 'referp',
    });
    const pro = resolveJeeMockTestTemplate({
      utm_source: 'WhatsApp',
      utm_medium: 'influencer',
      utm_campaign: 'guide_xperts',
      utm_content: 'PRO',
    });
    const direct = resolveJeeMockTestTemplate({});
    assert.equal(referp?.templateId, JEE_MOCK_TEST_DIRECT_TEMPLATE_ID);
    assert.equal(pro?.templateId, '75c795a8-56fe-467d-a353-f9dc9cc529f5');
    assert.equal(direct?.templateId, JEE_MOCK_TEST_DIRECT_TEMPLATE_ID);
    assert.equal(resolveJeeMockTestTemplate(null), null);
  });

  test('matches case-insensitively and ignores unrelated UTMs', () => {
    const match = resolveJeeMockTestTemplate({
      utm_source: 'Instagram',
      utm_medium: 'Influencer',
      utm_campaign: 'guide_xperts',
      utm_content: 'srilekha',
    });
    assert.equal(match?.utm_content, 'Srilekha');
    assert.equal(match?.templateId, '2df52f62-f55a-4509-8042-2301501fd42a');

    assert.equal(
      resolveJeeMockTestTemplate({
        utm_source: 'instagram',
        utm_medium: 'influencer',
        utm_campaign: 'other',
        utm_content: 'Jayanth',
      }),
      null
    );
    assert.equal(resolveJeeMockTestTemplate({ utm_content: 'Jayanth' }), null);
  });

  test('Counsellors link is the whatsapp source', () => {
    const match = resolveJeeMockTestTemplate({
      utm_source: 'whatsapp',
      utm_medium: 'influencer',
      utm_campaign: 'guide_xperts',
      utm_content: 'Counsellors',
    });
    assert.equal(match?.utm_source, 'whatsapp');
  });

  test('header image is the Cloudinary poster in code', () => {
    assert.equal(
      resolveJeeMockTestHeaderImageUrl(),
      'https://res.cloudinary.com/dfqdb1xws/image/upload/v1792824684/WhatsApp_Image_2026-10-24_at_12.16.29_PM_d0s6re.jpg'
    );
    assert.equal(JEE_MOCK_TEST_HEADER_IMAGE_URL, resolveJeeMockTestHeaderImageUrl());
  });

  test('name is the template variable', () => {
    assert.deepEqual(buildJeeMockTestSubmitVars({ name: 'Asha' }), { name: 'Asha', Name: 'Asha' });
    assert.deepEqual(buildJeeMockTestSubmitVars({ studentName: 'Asha' }), { name: 'Asha', Name: 'Asha' });
    assert.equal(buildJeeMockTestSubmitVars({}).name, 'Student');
  });

  test('ops product isolates jee_mock_test_submit', () => {
    assert.equal(parseOpsProductQuery('jee_mock_test'), 'jee_mock_test');
    assert.equal(parseOpsProductQuery('jee-mock-test'), 'jee_mock_test');
    assert.deepEqual(matchWhatsAppEventsByOpsProduct('jee_mock_test'), { opsProduct: 'jee_mock_test' });
    assert.equal(validateMessageKindForOpsProduct('jee_mock_test_submit', 'jee_mock_test'), null);
    assert.match(String(validateMessageKindForOpsProduct('jee_mock_test_submit', 'guidexpert') || ''), /GuideXpert/);
    assert.match(String(validateMessageKindForOpsProduct('slot_booked', 'jee_mock_test') || ''), /JEE Mock Test/);
    assert.equal(getTemplateMetaForKind('jee_mock_test_submit').templateIdEnvKey, 'GUPSHUP_TEMPLATE_JEE_MOCK_TEST_INFLUENCER');
  });

  test('retry group and message event accept the mock test kind', () => {
    const group = new WhatsAppRetryGroup({
      messageKind: 'jee_mock_test_submit',
      trigger: 'jee_mock_test_submit',
      status: 'open',
    });
    assert.equal(group.validateSync(), undefined);
    const event = new WhatsAppMessageEvent({
      phone: '9876543210',
      messageKind: 'jee_mock_test_submit',
      source: 'jee_mock_test_submit',
      opsProduct: 'jee_mock_test',
      status: 'submitted',
      attemptNumber: 1,
    });
    assert.equal(event.validateSync(), undefined);
  });
});
