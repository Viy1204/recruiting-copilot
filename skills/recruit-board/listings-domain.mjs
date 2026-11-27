import { ROLE_ID_PATTERN } from './model.mjs';

export const LISTINGS_SCHEMA_VERSION = 1;
export const LISTING_POLICIES = Object.freeze(['active', 'inbound_only', 'paused', 'ignore']);
export const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const TOP_FIELDS = Object.freeze(['schemaVersion', 'listings', 'description', 'verifiedAt', 'source']);
const LISTING_FIELDS = Object.freeze(['platform', 'externalJobId', 'title', 'roleIds', 'policy', 'note']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inputError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

function singleLineText(value, label, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f\u0085\p{Zl}\p{Zp}]/u.test(value)) {
    throw inputError('LISTINGS_INVALID', `${label} 必须为 1–${max} 字符的单行文本`);
  }
  return value.trim();
}

function optionalSingleLineText(value, label, max = 300) {
  if (value === undefined || value === null || value === '') return null;
  return singleLineText(value, label, max);
}

export function validatePlatform(value) {
  if (typeof value !== 'string' || !PLATFORM_PATTERN.test(value)) {
    throw inputError('LISTINGS_INVALID', '平台标识仅允许 1–32 位小写字母、数字、下划线或连字符，且须以字母或数字开头');
  }
  return value;
}

export function validateRoleId(value) {
  if (typeof value !== 'string' || !ROLE_ID_PATTERN.test(value)) {
    throw inputError('LISTINGS_INVALID', `role_id 格式无效：${String(value)}；须为 2–24 位大写字母、数字或连字符，且以字母或数字开头`);
  }
  return value;
}

export function normalizeListingEntry(value) {
  if (!isObject(value)) throw inputError('LISTINGS_INVALID', '平台职位条目必须为对象');
  const unknown = Object.keys(value).filter(key => !LISTING_FIELDS.includes(key));
  if (unknown.length) throw inputError('LISTINGS_INVALID', `平台职位条目包含未知字段：${unknown.join('、')}`);

  const platform = validatePlatform(value.platform);
  const externalJobId = singleLineText(value.externalJobId, '平台职位 ID', 128);
  const title = optionalSingleLineText(value.title, '平台职位标题', 300);
  const policy = singleLineText(value.policy, '路由策略', 32);
  if (!LISTING_POLICIES.includes(policy)) {
    throw inputError('LISTINGS_INVALID', `路由策略无效：${policy}；仅支持 ${LISTING_POLICIES.join('、')}`);
  }
  if (!Array.isArray(value.roleIds)) {
    throw inputError('LISTINGS_INVALID', `平台职位 ${platform}:${externalJobId} 的 roleIds 必须为数组`);
  }
  const seen = new Set();
  const roleIds = [];
  for (const rawId of value.roleIds) {
    const roleId = validateRoleId(rawId);
    if (seen.has(roleId)) {
      throw inputError('LISTINGS_INVALID', `平台职位 ${platform}:${externalJobId} 包含重复 role_id：${roleId}`);
    }
    seen.add(roleId);
    roleIds.push(roleId);
  }
  if (policy === 'ignore' && roleIds.length > 0) {
    throw inputError('LISTINGS_INVALID', `忽略策略的平台职位 ${platform}:${externalJobId} 不得关联 roleIds`);
  }
  if (policy !== 'ignore' && roleIds.length === 0) {
    throw inputError('LISTINGS_INVALID', `非忽略策略的平台职位 ${platform}:${externalJobId} 至少关联一个 role_id`);
  }
  const note = optionalSingleLineText(value.note, '备注', 300);

  const result = { platform, externalJobId };
  if (title !== null) result.title = title;
  result.roleIds = roleIds;
  result.policy = policy;
  if (note !== null) result.note = note;
  return result;
}

export function validateListingsConfig(value, knownRoleIds = null) {
  if (!isObject(value)) throw inputError('LISTINGS_INVALID', '外部职位路由表必须为对象');
  const unknown = Object.keys(value).filter(key => !TOP_FIELDS.includes(key));
  if (unknown.length) throw inputError('LISTINGS_INVALID', `外部职位路由表包含未知字段：${unknown.join('、')}`);
  if (value.schemaVersion !== LISTINGS_SCHEMA_VERSION) {
    throw inputError('LISTINGS_INVALID', `外部职位路由表 schemaVersion 必须为 ${LISTINGS_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.listings)) {
    throw inputError('LISTINGS_INVALID', '外部职位路由表 listings 必须为数组');
  }

  const listings = [];
  const seenKeys = new Set();
  for (const raw of value.listings) {
    const entry = normalizeListingEntry(raw);
    const key = `${entry.platform}:${entry.externalJobId}`;
    if (seenKeys.has(key)) {
      throw inputError('LISTINGS_INVALID', `存在重复的平台职位绑定：${key}`);
    }
    if (knownRoleIds) {
      for (const roleId of entry.roleIds) {
        if (!knownRoleIds.has(roleId)) {
          throw inputError('LISTING_DANGLING_ROLE_ID', `平台职位 ${key} 引用了 CONTEXT.md 中不存在的 role_id：${roleId}`, 422);
        }
      }
    }
    seenKeys.add(key);
    listings.push(entry);
  }

  const result = { schemaVersion: LISTINGS_SCHEMA_VERSION, listings };
  for (const meta of ['description', 'verifiedAt', 'source']) {
    if (Object.hasOwn(value, meta)) result[meta] = value[meta];
  }
  return result;
}

export function emptyListingsConfig() {
  return { schemaVersion: LISTINGS_SCHEMA_VERSION, listings: [] };
}

export function applyListingUpsert(current, listingInput, knownRoleIds = null) {
  const config = validateListingsConfig(current ?? emptyListingsConfig());
  const nextEntry = normalizeListingEntry(listingInput);
  if (knownRoleIds) {
    const key = `${nextEntry.platform}:${nextEntry.externalJobId}`;
    for (const roleId of nextEntry.roleIds) {
      if (!knownRoleIds.has(roleId)) {
        throw inputError('LISTING_DANGLING_ROLE_ID', `平台职位 ${key} 引用了 CONTEXT.md 中不存在的 role_id：${roleId}`, 422);
      }
    }
  }
  const index = config.listings.findIndex(
    item => item.platform === nextEntry.platform && item.externalJobId === nextEntry.externalJobId
  );
  const nextListings = index >= 0
    ? config.listings.map((item, idx) => (idx === index ? nextEntry : item))
    : [...config.listings, nextEntry];
  const nextConfig = validateListingsConfig({ ...config, listings: nextListings });
  const changed = index < 0 || JSON.stringify(config.listings[index]) !== JSON.stringify(nextEntry);
  return { config: nextConfig, listing: nextEntry, changed };
}

export function applyListingRemove(current, platform, externalJobId) {
  const config = validateListingsConfig(current);
  const normalizedPlatform = validatePlatform(platform);
  const normalizedJobId = singleLineText(externalJobId, '平台职位 ID', 128);
  const index = config.listings.findIndex(
    item => item.platform === normalizedPlatform && item.externalJobId === normalizedJobId
  );
  if (index < 0) {
    throw inputError('LISTING_NOT_FOUND', `未找到平台职位绑定：${normalizedPlatform}:${normalizedJobId}`, 404);
  }
  const nextListings = config.listings.filter((_, idx) => idx !== index);
  return {
    config: validateListingsConfig({ ...config, listings: nextListings }),
    removed: config.listings[index],
    changed: true
  };
}

export function resolveListingTarget(current, query, roleRows = []) {
  const config = validateListingsConfig(current);
  const rowByRoleId = new Map(roleRows.filter(row => row.roleId).map(row => [row.roleId, row]));
  const summarizeRole = id => {
    const row = rowByRoleId.get(id);
    return row
      ? { roleId: row.roleId, name: row.name, priority: row.priority, status: row.status, internalPath: row.internalPath }
      : { roleId: id, name: null, priority: null, status: null, internalPath: null };
  };

  if (query.platform !== undefined || query.externalJobId !== undefined) {
    const platform = validatePlatform(query.platform);
    const externalJobId = singleLineText(query.externalJobId, '平台职位 ID', 128);
    const listing = config.listings.find(item => item.platform === platform && item.externalJobId === externalJobId) ?? null;
    if (!listing) {
      return { matched: false, matchKind: null, policy: null, roleIds: [], roles: [], listing: null, listings: [] };
    }
    return {
      matched: true,
      matchKind: 'listing',
      policy: listing.policy,
      roleIds: [...listing.roleIds],
      roles: listing.roleIds.map(summarizeRole),
      listing,
      listings: [listing]
    };
  }

  if (query.roleId !== undefined) {
    const roleId = validateRoleId(query.roleId);
    const listings = config.listings.filter(item => item.roleIds.includes(roleId));
    if (!listings.length) {
      return { matched: false, matchKind: null, policy: null, roleIds: [], roles: [], listing: null, listings: [] };
    }
    return {
      matched: true,
      matchKind: 'roleId',
      policy: null,
      roleIds: [roleId],
      roles: [summarizeRole(roleId)],
      listing: null,
      listings
    };
  }

  throw inputError('LISTINGS_QUERY_INVALID', '查询条件必须指定 --platform + --external-job-id 或 --role-id');
}
