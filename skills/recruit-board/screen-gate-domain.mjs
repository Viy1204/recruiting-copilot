export const SCREENING_RULES_SCHEMA_VERSION = 1;

export const DEGREE_RANK = Object.freeze({
  中专: 1,
  高中: 1,
  大专: 2,
  专科: 2,
  本科: 3,
  硕士: 4,
  研究生: 4,
  博士: 5
});

export const SCHOOL_TIER_RANK = Object.freeze({
  普通: 1,
  民办: 1,
  二本: 2,
  一本: 3,
  '211': 4,
  双一流: 4,
  '985': 5
});

const TOP_FIELDS = Object.freeze(['schemaVersion', 'defaults', 'roles', 'schoolEquivalents', 'excludedSchools', 'description', 'verifiedAt', 'source']);
export const RULE_FIELDS = Object.freeze([
  'minAge',
  'maxAge',
  'minDegree',
  'requireFullTime',
  'excludeEducationTypes',
  'minSchoolTier',
  'minExperienceYears',
  'maxExperienceYears',
  'minExperienceByDegree',
  'minSalaryK',
  'maxSalaryK',
  'maxGapMonths',
  'maxRecentJobs',
  'exemptIfLongestTenureMonths',
  'maxInactiveDays',
  'allowedCities'
]);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inputError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

function singleLineText(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f\u0085\p{Zl}\p{Zp}]/u.test(value)) {
    throw inputError('SCREENING_RULES_INVALID', `${label} 必须为 1–${max} 字符的单行文本`);
  }
  return value.trim();
}

function nonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw inputError('SCREENING_RULES_INVALID', `${label} 必须为非负有限数字`);
  }
  return value;
}

function stringList(value, label) {
  if (!Array.isArray(value)) throw inputError('SCREENING_RULES_INVALID', `${label} 必须为字符串数组`);
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const clean = singleLineText(item, label, 120);
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

export function normalizeRuleBlock(raw, { allowNullOverride = false, label = '规则块' } = {}) {
  if (!isObject(raw)) throw inputError('SCREENING_RULES_INVALID', `${label} 必须为对象`);
  const unknown = Object.keys(raw).filter(key => !RULE_FIELDS.includes(key));
  if (unknown.length) throw inputError('SCREENING_RULES_INVALID', `${label} 包含未知字段：${unknown.join('、')}`);

  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === undefined) continue;
    if (val === null) {
      if (!allowNullOverride) throw inputError('SCREENING_RULES_INVALID', `${label}.${key} 不能为 null`);
      out[key] = null;
      continue;
    }
    if (['minAge', 'maxAge', 'minExperienceYears', 'maxExperienceYears', 'minSalaryK', 'maxSalaryK', 'maxGapMonths', 'maxRecentJobs', 'exemptIfLongestTenureMonths', 'maxInactiveDays'].includes(key)) {
      out[key] = nonNegativeNumber(val, `${label}.${key}`);
      continue;
    }
    if (key === 'requireFullTime') {
      if (typeof val !== 'boolean') throw inputError('SCREENING_RULES_INVALID', `${label}.requireFullTime 必须为布尔值`);
      out[key] = val;
      continue;
    }
    if (key === 'minDegree') {
      const degree = singleLineText(val, `${label}.minDegree`, 32);
      if (!Object.hasOwn(DEGREE_RANK, degree)) {
        throw inputError('SCREENING_RULES_INVALID', `${label}.minDegree 无效：${degree}；支持 ${Object.keys(DEGREE_RANK).join('、')}`);
      }
      out[key] = degree;
      continue;
    }
    if (key === 'minSchoolTier') {
      const tier = singleLineText(val, `${label}.minSchoolTier`, 32);
      if (!Object.hasOwn(SCHOOL_TIER_RANK, tier)) {
        throw inputError('SCREENING_RULES_INVALID', `${label}.minSchoolTier 无效：${tier}；支持 ${Object.keys(SCHOOL_TIER_RANK).join('、')}`);
      }
      out[key] = tier;
      continue;
    }
    if (key === 'excludeEducationTypes' || key === 'allowedCities') {
      out[key] = stringList(val, `${label}.${key}`);
      continue;
    }
    if (key === 'minExperienceByDegree') {
      if (!isObject(val)) throw inputError('SCREENING_RULES_INVALID', `${label}.minExperienceByDegree 必须为对象`);
      const map = {};
      for (const [deg, years] of Object.entries(val)) {
        const cleanDeg = singleLineText(deg, `${label}.minExperienceByDegree 键`, 32);
        if (!Object.hasOwn(DEGREE_RANK, cleanDeg)) {
          throw inputError('SCREENING_RULES_INVALID', `${label}.minExperienceByDegree 包含未知学历：${cleanDeg}`);
        }
        map[cleanDeg] = nonNegativeNumber(years, `${label}.minExperienceByDegree.${cleanDeg}`);
      }
      out[key] = map;
    }
  }
  if (typeof out.minAge === 'number' && typeof out.maxAge === 'number' && out.minAge > out.maxAge) {
    throw inputError('SCREENING_RULES_INVALID', `${label} 的 minAge 不能大于 maxAge`);
  }
  if (typeof out.minSalaryK === 'number' && typeof out.maxSalaryK === 'number' && out.minSalaryK > out.maxSalaryK) {
    throw inputError('SCREENING_RULES_INVALID', `${label} 的 minSalaryK 不能大于 maxSalaryK`);
  }
  if (typeof out.minExperienceYears === 'number' && typeof out.maxExperienceYears === 'number' && out.minExperienceYears > out.maxExperienceYears) {
    throw inputError('SCREENING_RULES_INVALID', `${label} 的 minExperienceYears 不能大于 maxExperienceYears`);
  }
  return out;
}

export function validateScreeningRules(value) {
  if (!isObject(value)) throw inputError('SCREENING_RULES_INVALID', '初筛规则配置必须为对象');
  const unknown = Object.keys(value).filter(key => !TOP_FIELDS.includes(key));
  if (unknown.length) throw inputError('SCREENING_RULES_INVALID', `初筛规则配置包含未知顶层字段：${unknown.join('、')}`);
  if (value.schemaVersion !== SCREENING_RULES_SCHEMA_VERSION) {
    throw inputError('SCREENING_RULES_INVALID', `初筛规则配置 schemaVersion 必须为 ${SCREENING_RULES_SCHEMA_VERSION}`);
  }
  const defaults = value.defaults === undefined ? {} : normalizeRuleBlock(value.defaults, { allowNullOverride: false, label: 'defaults' });
  const roles = {};
  if (value.roles !== undefined) {
    if (!isObject(value.roles)) throw inputError('SCREENING_RULES_INVALID', 'roles 必须为按岗位键映射的对象');
    for (const [rawKey, delta] of Object.entries(value.roles)) {
      const roleKey = singleLineText(rawKey, '岗位键', 300);
      if (Object.hasOwn(roles, roleKey)) throw inputError('SCREENING_RULES_INVALID', `roles 包含重复岗位键：${roleKey}`);
      roles[roleKey] = normalizeRuleBlock(delta, { allowNullOverride: true, label: `roles["${roleKey}"]` });
    }
  }
  const schoolEquivalents = {};
  if (value.schoolEquivalents !== undefined) {
    if (!isObject(value.schoolEquivalents)) throw inputError('SCREENING_RULES_INVALID', 'schoolEquivalents 必须为对象');
    for (const [rawSchool, rawTier] of Object.entries(value.schoolEquivalents)) {
      const school = singleLineText(rawSchool, '院校名称', 120);
      const tier = singleLineText(rawTier, '等价层次', 32);
      if (!Object.hasOwn(SCHOOL_TIER_RANK, tier)) {
        throw inputError('SCREENING_RULES_INVALID', `schoolEquivalents["${school}"] 层次无效：${tier}`);
      }
      schoolEquivalents[school] = tier;
    }
  }
  const excludedSchools = value.excludedSchools === undefined ? [] : stringList(value.excludedSchools, 'excludedSchools');

  const result = { schemaVersion: SCREENING_RULES_SCHEMA_VERSION, defaults, roles, schoolEquivalents, excludedSchools };
  for (const meta of ['description', 'verifiedAt', 'source']) {
    if (Object.hasOwn(value, meta)) result[meta] = value[meta];
  }
  return result;
}

/**
 * Compile effective rules for ONE single role: global defaults + that role's delta only.
 * Explicit `null` in a role override relaxes/disables an inherited default rule.
 */
export function compileEffectiveRules(config, roleKey, { fallbackKeys = [] } = {}) {
  const validated = validateScreeningRules(config);
  const candidates = [roleKey, ...fallbackKeys].filter(Boolean);
  let matchedRoleKey = null;
  for (const key of candidates) {
    if (Object.hasOwn(validated.roles, key)) {
      matchedRoleKey = key;
      break;
    }
  }
  const delta = matchedRoleKey ? validated.roles[matchedRoleKey] : {};
  const rules = {};
  const provenance = {};

  for (const field of RULE_FIELDS) {
    if (Object.hasOwn(delta, field)) {
      if (delta[field] === null) {
        provenance[field] = 'relaxed-by-role';
      } else {
        rules[field] = delta[field];
        provenance[field] = 'role-override';
      }
    } else if (Object.hasOwn(validated.defaults, field)) {
      rules[field] = validated.defaults[field];
      provenance[field] = 'default';
    }
  }

  // Validate merged range coherence (e.g. role overrides maxAge below global minAge)
  if (typeof rules.minAge === 'number' && typeof rules.maxAge === 'number' && rules.minAge > rules.maxAge) {
    throw inputError('SCREENING_RULES_INVALID', `岗位 ${roleKey} 合并后的 minAge(${rules.minAge}) 大于 maxAge(${rules.maxAge})`);
  }
  if (typeof rules.minSalaryK === 'number' && typeof rules.maxSalaryK === 'number' && rules.minSalaryK > rules.maxSalaryK) {
    throw inputError('SCREENING_RULES_INVALID', `岗位 ${roleKey} 合并后的 minSalaryK(${rules.minSalaryK}) 大于 maxSalaryK(${rules.maxSalaryK})`);
  }
  if (typeof rules.minExperienceYears === 'number' && typeof rules.maxExperienceYears === 'number' && rules.minExperienceYears > rules.maxExperienceYears) {
    throw inputError('SCREENING_RULES_INVALID', `岗位 ${roleKey} 合并后的 minExperienceYears(${rules.minExperienceYears}) 大于 maxExperienceYears(${rules.maxExperienceYears})`);
  }

  return {
    roleKey,
    matchedRoleKey,
    hasRoleOverride: matchedRoleKey !== null,
    rules,
    provenance,
    schoolEquivalents: validated.schoolEquivalents,
    excludedSchools: validated.excludedSchools
  };
}

export function evaluateCandidate(compiled, candidate) {
  if (!isObject(candidate)) throw inputError('CANDIDATE_INPUT_INVALID', '候选人数据必须为对象');
  const { rules, provenance, schoolEquivalents, excludedSchools } = compiled;
  const failedRules = [];
  const passedRules = [];
  const missingFields = [];

  const fail = (rule, expected, actual, reason) => failedRules.push({
    rule,
    source: provenance[rule] ?? 'global',
    expected,
    actual,
    reason
  });
  const pass = (rule, actual) => passedRules.push({
    rule,
    source: provenance[rule] ?? 'global',
    actual
  });

  // 1. Age
  if (rules.minAge !== undefined || rules.maxAge !== undefined) {
    if (typeof candidate.age !== 'number' || !Number.isFinite(candidate.age)) {
      missingFields.push('age');
    } else {
      if (rules.minAge !== undefined && candidate.age < rules.minAge) {
        fail('minAge', `>=${rules.minAge}`, candidate.age, `年龄 ${candidate.age} 岁低于下限 ${rules.minAge} 岁`);
      } else if (rules.minAge !== undefined) {
        pass('minAge', candidate.age);
      }
      if (rules.maxAge !== undefined && candidate.age > rules.maxAge) {
        fail('maxAge', `<=${rules.maxAge}`, candidate.age, `年龄 ${candidate.age} 岁超过上限 ${rules.maxAge} 岁`);
      } else if (rules.maxAge !== undefined) {
        pass('maxAge', candidate.age);
      }
    }
  }

  // 2. Degree
  const degreeRank = typeof candidate.degree === 'string' && Object.hasOwn(DEGREE_RANK, candidate.degree.trim())
    ? DEGREE_RANK[candidate.degree.trim()]
    : null;
  if (rules.minDegree !== undefined) {
    if (degreeRank === null) {
      missingFields.push('degree');
    } else if (degreeRank < DEGREE_RANK[rules.minDegree]) {
      fail('minDegree', `>=${rules.minDegree}`, candidate.degree.trim(), `学历 ${candidate.degree.trim()} 低于门槛 ${rules.minDegree}`);
    } else {
      pass('minDegree', candidate.degree.trim());
    }
  }

  // 3. Full-time & excluded education types
  if (rules.requireFullTime === true) {
    if (typeof candidate.fullTime !== 'boolean') {
      missingFields.push('fullTime');
    } else if (!candidate.fullTime) {
      fail('requireFullTime', true, false, '要求统招全日制学历');
    } else {
      pass('requireFullTime', true);
    }
  }
  if (Array.isArray(rules.excludeEducationTypes) && rules.excludeEducationTypes.length > 0) {
    const eduType = typeof candidate.educationType === 'string' ? candidate.educationType.trim() : '';
    if (eduType && rules.excludeEducationTypes.includes(eduType)) {
      fail('excludeEducationTypes', `排除 ${rules.excludeEducationTypes.join('/')}`, eduType, `学历性质「${eduType}」命中排除规则`);
    } else if (eduType) {
      pass('excludeEducationTypes', eduType);
    }
  }

  // 4. School blacklist & school tier (with equivalents)
  const schoolName = typeof candidate.school === 'string' ? candidate.school.trim() : '';
  if (schoolName && excludedSchools.some(item => schoolName === item || schoolName.includes(item))) {
    fail('excludedSchools', '不在排除院校名单', schoolName, `毕业院校「${schoolName}」命中排除名单`);
  }
  if (rules.minSchoolTier !== undefined) {
    let effectiveTier = null;
    if (schoolName && Object.hasOwn(schoolEquivalents, schoolName)) {
      effectiveTier = schoolEquivalents[schoolName];
    } else if (typeof candidate.schoolTier === 'string' && Object.hasOwn(SCHOOL_TIER_RANK, candidate.schoolTier.trim())) {
      effectiveTier = candidate.schoolTier.trim();
    }
    if (!effectiveTier) {
      missingFields.push('schoolTier');
    } else if (SCHOOL_TIER_RANK[effectiveTier] < SCHOOL_TIER_RANK[rules.minSchoolTier]) {
      fail('minSchoolTier', `>=${rules.minSchoolTier}`, effectiveTier, `院校层次「${effectiveTier}」低于门槛「${rules.minSchoolTier}」`);
    } else {
      pass('minSchoolTier', effectiveTier);
    }
  }

  // 5. Experience years (including optional per-degree minimum)
  const minExpFromDegree = rules.minExperienceByDegree && typeof candidate.degree === 'string' && Object.hasOwn(rules.minExperienceByDegree, candidate.degree.trim())
    ? rules.minExperienceByDegree[candidate.degree.trim()]
    : undefined;
  const effectiveMinExp = minExpFromDegree !== undefined ? minExpFromDegree : rules.minExperienceYears;
  if (effectiveMinExp !== undefined || rules.maxExperienceYears !== undefined) {
    if (typeof candidate.experienceYears !== 'number' || !Number.isFinite(candidate.experienceYears)) {
      missingFields.push('experienceYears');
    } else {
      if (effectiveMinExp !== undefined && candidate.experienceYears < effectiveMinExp) {
        const ruleName = minExpFromDegree !== undefined ? 'minExperienceByDegree' : 'minExperienceYears';
        fail(ruleName, `>=${effectiveMinExp}年`, candidate.experienceYears, `工作年限 ${candidate.experienceYears} 年低于要求 ${effectiveMinExp} 年`);
      } else if (effectiveMinExp !== undefined) {
        pass(minExpFromDegree !== undefined ? 'minExperienceByDegree' : 'minExperienceYears', candidate.experienceYears);
      }
      if (rules.maxExperienceYears !== undefined && candidate.experienceYears > rules.maxExperienceYears) {
        fail('maxExperienceYears', `<=${rules.maxExperienceYears}年`, candidate.experienceYears, `工作年限 ${candidate.experienceYears} 年超过上限 ${rules.maxExperienceYears} 年`);
      } else if (rules.maxExperienceYears !== undefined) {
        pass('maxExperienceYears', candidate.experienceYears);
      }
    }
  }

  // 6. Expected salary (K)
  if (rules.minSalaryK !== undefined || rules.maxSalaryK !== undefined) {
    if (typeof candidate.expectedSalaryK !== 'number' || !Number.isFinite(candidate.expectedSalaryK)) {
      missingFields.push('expectedSalaryK');
    } else {
      if (rules.minSalaryK !== undefined && candidate.expectedSalaryK < rules.minSalaryK) {
        fail('minSalaryK', `>=${rules.minSalaryK}K`, candidate.expectedSalaryK, `期望薪资 ${candidate.expectedSalaryK}K 低于下限 ${rules.minSalaryK}K`);
      } else if (rules.minSalaryK !== undefined) {
        pass('minSalaryK', candidate.expectedSalaryK);
      }
      if (rules.maxSalaryK !== undefined && candidate.expectedSalaryK > rules.maxSalaryK) {
        fail('maxSalaryK', `<=${rules.maxSalaryK}K`, candidate.expectedSalaryK, `期望薪资 ${candidate.expectedSalaryK}K 超过上限 ${rules.maxSalaryK}K`);
      } else if (rules.maxSalaryK !== undefined) {
        pass('maxSalaryK', candidate.expectedSalaryK);
      }
    }
  }

  // 7. Career gap
  if (rules.maxGapMonths !== undefined) {
    if (typeof candidate.gapMonths !== 'number' || !Number.isFinite(candidate.gapMonths)) {
      missingFields.push('gapMonths');
    } else if (candidate.gapMonths > rules.maxGapMonths) {
      fail('maxGapMonths', `<=${rules.maxGapMonths}月`, candidate.gapMonths, `职业空白期 ${candidate.gapMonths} 个月超过上限 ${rules.maxGapMonths} 个月`);
    } else {
      pass('maxGapMonths', candidate.gapMonths);
    }
  }

  // 8. Job hopping with continuous tenure exemption
  if (rules.maxRecentJobs !== undefined) {
    if (typeof candidate.recentJobCount !== 'number' || !Number.isFinite(candidate.recentJobCount)) {
      missingFields.push('recentJobCount');
    } else if (candidate.recentJobCount > rules.maxRecentJobs) {
      const exemptThreshold = rules.exemptIfLongestTenureMonths;
      const longestTenure = typeof candidate.longestTenureMonths === 'number' && Number.isFinite(candidate.longestTenureMonths)
        ? candidate.longestTenureMonths
        : null;
      if (exemptThreshold !== undefined && longestTenure !== null && longestTenure >= exemptThreshold) {
        pass('maxRecentJobs', `${candidate.recentJobCount}段（最长单段${longestTenure}月触发豁免）`);
      } else {
        fail('maxRecentJobs', `<=${rules.maxRecentJobs}段`, candidate.recentJobCount, `近窗履历 ${candidate.recentJobCount} 段超过上限 ${rules.maxRecentJobs} 段`);
      }
    } else {
      pass('maxRecentJobs', candidate.recentJobCount);
    }
  }

  // 9. Activity recency
  if (rules.maxInactiveDays !== undefined) {
    if (typeof candidate.inactiveDays !== 'number' || !Number.isFinite(candidate.inactiveDays)) {
      missingFields.push('inactiveDays');
    } else if (candidate.inactiveDays > rules.maxInactiveDays) {
      fail('maxInactiveDays', `<=${rules.maxInactiveDays}天`, candidate.inactiveDays, `活跃度 ${candidate.inactiveDays} 天前超过上限 ${rules.maxInactiveDays} 天`);
    } else {
      pass('maxInactiveDays', candidate.inactiveDays);
    }
  }

  // 10. City
  if (Array.isArray(rules.allowedCities) && rules.allowedCities.length > 0) {
    const city = typeof candidate.city === 'string' ? candidate.city.trim() : '';
    if (!city) {
      missingFields.push('city');
    } else if (!rules.allowedCities.some(allowed => city === allowed || city.includes(allowed))) {
      fail('allowedCities', rules.allowedCities.join('/'), city, `所在/期望城市「${city}」不在允许范围（${rules.allowedCities.join('、')}）`);
    } else {
      pass('allowedCities', city);
    }
  }

  const verdict = failedRules.length > 0
    ? 'REJECT_HARD_GATE'
    : missingFields.length > 0
      ? 'NEED_DETAIL'
      : 'PASS_HARD_GATES';

  return {
    verdict,
    roleKey: compiled.roleKey,
    candidateName: typeof candidate.name === 'string' ? candidate.name.trim() : null,
    failedRules,
    passedRules,
    missingFields: [...new Set(missingFields)]
  };
}

/**
 * Extract ONLY global policy sections from CONTEXT.md for single-role context packing,
 * stripping out the multi-role table and historical decisions so screening stays O(1).
 */
export function extractGlobalPolicyFromContext(contextText) {
  const lines = contextText.replace(/^\uFEFF/, '').split(/\r?\n/);
  const globalPatterns = [
    /^(?:[一二三四五六七八九十\d]+[、.．]\s*)?公司与业务背景$/,
    /^(?:[一二三四五六七八九十\d]+[、.．]\s*)?招聘底层方法论/,
    /^(?:[一二三四五六七八九十\d]+[、.．]\s*)?初筛硬规则/,
    /^(?:[一二三四五六七八九十\d]+[、.．]\s*)?术语表$/
  ];
  const kept = [];
  let include = false;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading && heading[1].length === 2) {
      const title = heading[2].trim();
      include = globalPatterns.some(pattern => pattern.test(title));
    }
    if (include) kept.push(line);
  }
  return kept.join('\n').trim();
}
