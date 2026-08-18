/**
 * Read-only occupation cleanup for the Counsellors occupations admin view.
 * Never rewrite stored Mongo strings — only compute a display/filter category.
 *
 * Rules:
 * - Typos of the same word are merged (techer → Teacher).
 * - Short forms stay their own categories (SE is not Software Engineer).
 * - Unmatched values become a cleaned title-case category (nothing dropped).
 * - Empty / placeholder values become "Not specified".
 */

const NOT_SPECIFIED = 'Not specified';

/** OTP / non-job placeholders that must not appear in the counsellor-occupations view. */
const SYNTHETIC_EXACT = new Set([
  'resource download',
  'iit first form',
  'iit second form',
  'iit form',
  'collegedost form',
  'college dost form',
  'one on one iit session',
  'one-on-one iit session',
  '1-on-1 counseling',
  '1 on 1 counseling',
  '1-on-1 counselling',
  'meeting attendee',
  'orientation attendee',
  'guidance session meet',
  'nat campaign',
]);

const SYNTHETIC_PREFIXES = [
  'student —',
  'student –',
  'student -',
];

const SYNTHETIC_INCLUDES = [
  'rank predictor',
  'guidexpert tools',
];

/**
 * Short forms stay as their own filter chips. Keys are matchKey() results
 * (lowercase, dots stripped, spaces collapsed).
 */
const ACRONYM_CATEGORIES = {
  se: 'SE',
  sw: 'SW',
  hr: 'HR',
  it: 'IT',
  ba: 'BA',
  ma: 'MA',
  be: 'BE',
  btech: 'B.Tech',
  mtech: 'M.Tech',
  mba: 'MBA',
  ca: 'CA',
  cs: 'CS',
  bsc: 'BSc',
  msc: 'MSc',
  bcom: 'BCom',
  mcom: 'MCom',
  bba: 'BBA',
  bca: 'BCA',
  mca: 'MCA',
  llb: 'LLB',
  phd: 'PhD',
  ug: 'UG',
  pg: 'PG',
};

/**
 * Canonical counsellor-apply answers + same-word typos / obvious aliases.
 * Keys are matchKey() results. Do not expand acronyms here.
 */
const CANONICAL_CATEGORIES = {
  teacher: 'Teacher',
  techer: 'Teacher',
  tearcher: 'Teacher',
  teachar: 'Teacher',
  teachr: 'Teacher',
  teecher: 'Teacher',
  'school teacher': 'Teacher',
  schoolteacher: 'Teacher',
  'govt teacher': 'Teacher',
  'government teacher': 'Teacher',
  'private teacher': 'Teacher',
  'tuition teacher': 'Teacher',
  tutor: 'Teacher',
  tution: 'Teacher',
  tuition: 'Teacher',

  lecturer: 'Lecturer',
  lecturar: 'Lecturer',
  leacturer: 'Lecturer',
  'junior lecturer': 'Lecturer',
  'jr lecturer': 'Lecturer',

  professor: 'Professor',
  prof: 'Professor',
  faculty: 'Faculty',

  student: 'Student',
  studnet: 'Student',
  studnt: 'Student',
  students: 'Student',

  homemaker: 'Homemaker',
  'home maker': 'Homemaker',
  homemakr: 'Homemaker',
  homaker: 'Homemaker',

  housewife: 'Housewife',
  'house wife': 'Housewife',
  houswife: 'Housewife',
  housewifee: 'Housewife',
  hw: 'Housewife',

  engineer: 'Engineer',
  enginer: 'Engineer',
  enginner: 'Engineer',
  engneer: 'Engineer',
  engg: 'Engineer',
  engineering: 'Engineer',

  'software engineer': 'Software Engineer',
  softwareengineer: 'Software Engineer',
  'software engg': 'Software Engineer',
  'software enginer': 'Software Engineer',
  'softwear engineer': 'Software Engineer',
  'softeware engineer': 'Software Engineer',

  'software developer': 'Software Developer',
  developer: 'Software Developer',

  doctor: 'Doctor',
  docter: 'Doctor',
  physician: 'Doctor',

  advocate: 'Advocate',
  advocat: 'Advocate',
  advacate: 'Advocate',
  lawyer: 'Advocate',

  business: 'Business',
  bussiness: 'Business',
  buisness: 'Business',
  businessman: 'Business',
  'business man': 'Business',
  businesswoman: 'Business',
  'self employed': 'Business',
  selfemployed: 'Business',
  'self-employed': 'Business',
  entrepreneur: 'Business',

  farmer: 'Farmer',
  farming: 'Farmer',

  'government employee': 'Government employee',
  'govt employee': 'Government employee',
  'govt emp': 'Government employee',
  'govt job': 'Government employee',
  'government job': 'Government employee',
  'govt servant': 'Government employee',
  'gov employee': 'Government employee',

  retired: 'Retired',
  retire: 'Retired',
  pensioner: 'Retired',

  unemployed: 'Unemployed',
  unemployeed: 'Unemployed',
  'not working': 'Unemployed',
  'no occupation': 'Unemployed',
  'not employed': 'Unemployed',

  accountant: 'Accountant',
  accountent: 'Accountant',
  nurse: 'Nurse',
  pharmacist: 'Pharmacist',
  designer: 'Designer',
  manager: 'Manager',
  consultant: 'Consultant',
  banker: 'Banker',
  'bank employee': 'Banker',
  sales: 'Sales',
  marketing: 'Marketing',
  police: 'Police',
  army: 'Army',
  military: 'Army',
  'private employee': 'Private employee',
  'private job': 'Private employee',
  'daily wage': 'Daily wage',
  labour: 'Labour',
  labor: 'Labour',
  shopkeeper: 'Shopkeeper',
  'shop keeper': 'Shopkeeper',
  'shop owner': 'Shopkeeper',
};

const EMPTY_PLACEHOLDERS = new Set([
  '',
  '-',
  '--',
  'na',
  'n/a',
  'n a',
  'nil',
  'none',
  'null',
  'undefined',
  'not specified',
  'notapplicable',
  'not applicable',
  'no',
]);

function collapseSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Trim, collapse spaces, strip punctuation noise. Keep letters, digits, & . / -
 */
function cleanOccupation(raw) {
  const s = String(raw == null ? '' : raw)
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[_]+/g, ' ')
    .trim();
  if (!s) return '';
  return collapseSpaces(
    s.replace(/[!,;:?"()[\]{}<>*#@~`^+=|\\]/g, ' ').replace(/\s+/g, ' ')
  );
}

function matchKey(cleaned) {
  return collapseSpaces(cleaned)
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s*\/\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTitleCase(cleaned) {
  return collapseSpaces(cleaned)
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      const key = matchKey(word);
      if (ACRONYM_CATEGORIES[key]) return ACRONYM_CATEGORIES[key];
      if (/^[A-Za-z]\.[A-Za-z]/.test(word)) {
        return word
          .split('.')
          .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : ''))
          .join('.');
      }
      if (/^[A-Z0-9]{2,6}$/.test(word) && word === word.toUpperCase()) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function isSyntheticOccupation(raw) {
  const cleaned = cleanOccupation(raw);
  if (!cleaned) return false;
  const lower = cleaned.toLowerCase();
  const key = matchKey(cleaned);
  if (SYNTHETIC_EXACT.has(lower) || SYNTHETIC_EXACT.has(key)) return true;
  if (SYNTHETIC_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  if (SYNTHETIC_INCLUDES.some((needle) => lower.includes(needle))) return true;
  return false;
}

/**
 * @param {unknown} raw
 * @returns {{ occupationRaw: string, occupationCategory: string }}
 */
function normalizeOccupation(raw) {
  const occupationRaw = raw == null ? '' : String(raw);
  const cleaned = cleanOccupation(occupationRaw);
  const key = matchKey(cleaned);

  if (!key || EMPTY_PLACEHOLDERS.has(key)) {
    return { occupationRaw, occupationCategory: NOT_SPECIFIED };
  }

  if (ACRONYM_CATEGORIES[key]) {
    return { occupationRaw, occupationCategory: ACRONYM_CATEGORIES[key] };
  }

  if (CANONICAL_CATEGORIES[key]) {
    return { occupationRaw, occupationCategory: CANONICAL_CATEGORIES[key] };
  }

  return {
    occupationRaw,
    occupationCategory: toTitleCase(cleaned) || NOT_SPECIFIED,
  };
}

module.exports = {
  NOT_SPECIFIED,
  cleanOccupation,
  isSyntheticOccupation,
  normalizeOccupation,
};
