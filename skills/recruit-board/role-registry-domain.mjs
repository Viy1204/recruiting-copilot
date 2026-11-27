import { createHash } from 'node:crypto';

export const ROLE_REGISTRY_SCHEMA_VERSION = 1;
export const ROLE_STATUSES = Object.freeze(['在招', '已下架', '已关闭', '暂停', '待核']);
export const LISTING_POLICIES = Object.freeze(['active', 'inbound_only', 'paused', 'ignore']);

export const roleIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const platformPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const REGISTRY_FIELDS = Object.freeze(['schemaVersion', 'roles', 'listings', 'description', 'verifiedAt', 'source']);
const ROLE_FIELDS = Object.freeze(['id', 'name', 'priority', 'status', 'owner', 'atsRequisitionId', 'aliases', 'jdPath', 'internalPath']);
const LISTING_FIELDS = Object.freeze(['platform', 'externalJobId', 'title', 'roleIds', 'policy', 'note']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inputError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

function singleLineText(value, label, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f\u0085\p{Zl}\p{Zp}]/u.test(value)) {
    throw inputError('ROLE_REGISTRY_INVALID', `${label} 必须为 1–${max} 字符的单行文本`);
  }
  return value.trim();
}

function optionalSingleLineText(value, label, max = 300) {
  if (value === undefined || value === null || value === '') return null;
  return singleLineText(value, label, max);
}

function optionalRelativePath(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const text = singleLineText(value, label, 512);
  if (text.startsWith('/') || text.startsWith('\\') || /^[a-zA-Z]:/.test(text) || text.includes('\\')) {
    throw inputError('ROLE_REGISTRY_INVALID', `${label} 必须为使用正斜杠的工作区相对路径`);
  }
  const segments = text.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw inputError('ROLE_REGISTRY_INVALID', `${label} 包含非法路径段`);
  }
  return text;
}

function checkFields(value, allowed, label) {
  if (!isObject(value)) throw inputError('ROLE_REGISTRY_INVALID', `${label} 必须为对象`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw inputError('ROLE_REGISTRY_INVALID', `${label} 包含未知字段：${unknown.join('、')}`);
}

export function validateRoleId(value) {
  if (typeof value !== 'string' || !roleIdPattern.test(value)) {
    throw inputError('ROLE_REGISTRY_INVALID', '岗位固定 ID 仅允许 1–64 位字母、数字、点、下划线或连字符，且须以字母或数字开头');
  }
  return value;
}

export function validatePlatform(value) {
  if (typeof value !== 'string' || !platformPattern.test(value)) {
    throw inputError('ROLE_REGISTRY_INVALID', '平台标识仅允许 1–32 位小写字母、数字、下划线或连字符，且须以字母或数字开头');
  }
  return value;
}

export function generateRoleId(name, existingIds = new Set()) {
  const normalized = singleLineText(name, '岗位名称', 300);
  const ascii = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  const base = ascii ? `role-${ascii}-${hash}` : `role-${hash}`;
  if (!existingIds.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  throw inputError('ROLE_REGISTRY_INVALID', '无法生成唯一的岗位固定 ID');
}

export function normalizeRoleEntry(value) {
  checkFields(value, ROLE_FIELDS, '岗位条目');
  const id = validateRoleId(value.id);
  const name = singleLineText(value.name, '岗位名称', 300);
  const priority = optionalSingleLineText(value.priority, '优先级', 32);
  let status = null;
  if (value.status !== undefined && value.status !== null && value.status !== '') {
    const rawStatus = singleLineText(value.status, '岗位状态', 32);
    if (!ROLE_STATUSES.includes(rawStatus)) {
      throw inputError('ROLE_REGISTRY_INVALID', `岗位状态无效：${rawStatus}；仅支持 ${ROLE_STATUSES.join('、')}`);
    }
    status = rawStatus;
  }
  const owner = optionalSingleLineText(value.owner, '负责人', 80);
  const atsRequisitionId = optionalSingleLineText(value.atsRequisitionId, 'ATS 需求单号', 80);
  let aliases = [];
  if (value.aliases !== undefined) {
    if (!Array.isArray(value.aliases)) throw inputError('ROLE_REGISTRY_INVALID', '岗位 aliases 必须为字符串数组');
    const seen = new Set();
    for (const raw of value.aliases) {
      const alias = singleLineText(raw, '岗位别名', 300);
      if (alias === name || alias === id) {
        throw inputError('ROLE_REGISTRY_INVALID', `岗位别名不能与本岗位名称或 ID 重复：${alias}`);
      }
      if (seen.has(alias)) throw inputError('ROLE_REGISTRY_INVALID', `岗位 ${id} 包含重复别名：${alias}`);
      seen.add(alias);
      aliases.push(alias);
    }
  }
  const jdPath = optionalRelativePath(value.jdPath, '对外 JD 路径');
  const internalPath = optionalRelativePath(value.internalPath, '对内笔记路径');
  const result = { id, name };
  if (priority !== null) result.priority = priority;
  if (status !== null) result.status = status;
  if (owner !== null) result.owner = owner;
  if (atsRequisitionId !== null) result.atsRequisitionId = atsRequisitionId;
  if (aliases.length) result.aliases = aliases;
  if (jdPath !== null) result.jdPath = jdPath;
  if (internalPath !== null) result.internalPath = internalPath;
  return result;
}

export function normalizeListingEntry(value) {
  checkFields(value, LISTING_FIELDS, '平台职位映射');
  const platform = validatePlatform(value.platform);
  const externalJobId = singleLineText(value.externalJobId, '平台职位 ID', 128);
  const title = optionalSingleLineText(value.title, '平台职位标题', 300);
  const policy = singleLineText(value.policy, '映射策略', 32);
  if (!LISTING_POLICIES.includes(policy)) {
    throw inputError('ROLE_REGISTRY_INVALID', `映射策略无效：${policy}；仅支持 ${LISTING_POLICIES.join('、')}`);
  }
  if (!Array.isArray(value.roleIds)) {
    throw inputError('ROLE_REGISTRY_INVALID', '平台职位映射的 roleIds 必须为数组');
  }
  const seen = new Set();
  const roleIds = [];
  for (const rawId of value.roleIds) {
    const roleId = validateRoleId(rawId);
    if (seen.has(roleId)) throw inputError('ROLE_REGISTRY_INVALID', `平台职位 ${platform}:${externalJobId} 包含重复 roleId：${roleId}`);
    seen.add(roleId);
    roleIds.push(roleId);
  }
  if (policy === 'ignore' && roleIds.length > 0) {
    throw inputError('ROLE_REGISTRY_INVALID', `忽略策略的平台职位 ${platform}:${externalJobId} 不得关联 roleIds`);
  }
  if (policy !== 'ignore' && roleIds.length === 0) {
    throw inputError('ROLE_REGISTRY_INVALID', `非忽略策略的平台职位 ${platform}:${externalJobId} 至少关联一个岗位固定 ID`);
  }
  const note = optionalSingleLineText(value.note, '备注', 300);
  const result = { platform, externalJobId };
  if (title !== null) result.title = title;
  result.roleIds = roleIds;
  result.policy = policy;
  if (note !== null) result.note = note;
  return result;
}

export function validateRoleRegistry(value) {
  checkFields(value, REGISTRY_FIELDS, '岗位注册表');
  if (value.schemaVersion !== ROLE_REGISTRY_SCHEMA_VERSION) {
    throw inputError('ROLE_REGISTRY_INVALID', `岗位注册表 schemaVersion 必须为 ${ROLE_REGISTRY_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.roles)) throw inputError('ROLE_REGISTRY_INVALID', '岗位注册表 roles 必须为数组');
  if (!Array.isArray(value.listings)) throw inputError('ROLE_REGISTRY_INVALID', '岗位注册表 listings 必须为数组');

  const roles = [];
  const roleById = new Map();
  const roleByName = new Map();
  for (const rawRole of value.roles) {
    const role = normalizeRoleEntry(rawRole);
    if (roleById.has(role.id)) throw inputError('ROLE_REGISTRY_INVALID', `存在重复的岗位固定 ID：${role.id}`);
    if (roleByName.has(role.name)) throw inputError('ROLE_REGISTRY_INVALID', `存在重复的标准岗位名：${role.name}`);
    roleById.set(role.id, role);
    roleByName.set(role.name, role);
    roles.push(role);
  }

  const aliasOwner = new Map();
  for (const role of roles) {
    for (const alias of role.aliases ?? []) {
      if (roleByName.has(alias)) {
        throw inputError('ROLE_REGISTRY_INVALID', `岗位别名与正式岗位名冲突：${alias}`);
      }
      if (roleById.has(alias)) {
        throw inputError('ROLE_REGISTRY_INVALID', `岗位别名与岗位固定 ID 冲突：${alias}`);
      }
      if (aliasOwner.has(alias)) {
        throw inputError('ROLE_REGISTRY_INVALID', `岗位别名重复归属多个岗位：${alias}`);
      }
      aliasOwner.set(alias, role.id);
    }
  }

  const listings = [];
  const listingKeys = new Set();
  for (const rawListing of value.listings) {
    const listing = normalizeListingEntry(rawListing);
    const key = `${listing.platform}:${listing.externalJobId}`;
    if (listingKeys.has(key)) throw inputError('ROLE_REGISTRY_INVALID', `存在重复的平台职位映射：${key}`);
    for (const roleId of listing.roleIds) {
      if (!roleById.has(roleId)) {
        throw inputError('ROLE_REGISTRY_INVALID', `平台职位 ${key} 引用了不存在的岗位固定 ID：${roleId}`);
      }
    }
    listingKeys.add(key);
    listings.push(listing);
  }

  const result = { schemaVersion: ROLE_REGISTRY_SCHEMA_VERSION, roles, listings };
  for (const meta of ['description', 'verifiedAt', 'source']) {
    if (Object.hasOwn(value, meta)) result[meta] = value[meta];
  }
  return result;
}

export function emptyRoleRegistry() {
  return { schemaVersion: ROLE_REGISTRY_SCHEMA_VERSION, roles: [], listings: [] };
}

export function applyRoleUpsert(current, roleInput) {
  const registry = validateRoleRegistry(current ?? emptyRoleRegistry());
  const nextRole = normalizeRoleEntry(roleInput);
  const index = registry.roles.findIndex(item => item.id === nextRole.id);
  const nextRoles = index >= 0
    ? registry.roles.map((item, idx) => (idx === index ? nextRole : item))
    : [...registry.roles, nextRole];
  const candidate = validateRoleRegistry({ ...registry, roles: nextRoles });
  const changed = index < 0 || JSON.stringify(registry.roles[index]) !== JSON.stringify(nextRole);
  return { registry: candidate, role: nextRole, changed };
}

export function applyRoleRemove(current, roleId) {
  const registry = validateRoleRegistry(current);
  const id = validateRoleId(roleId);
  const index = registry.roles.findIndex(item => item.id === id);
  if (index < 0) throw inputError('ROLE_NOT_FOUND', `未找到岗位固定 ID：${id}`, 404);
  const referencing = registry.listings.filter(item => item.roleIds.includes(id));
  if (referencing.length) {
    const keys = referencing.map(item => `${item.platform}:${item.externalJobId}`).join('、');
    throw inputError('ROLE_IN_USE', `岗位 ${id} 仍被平台职位引用（${keys}），请先解绑平台职位映射`, 409);
  }
  const nextRoles = registry.roles.filter(item => item.id !== id);
  return { registry: validateRoleRegistry({ ...registry, roles: nextRoles }), removed: registry.roles[index], changed: true };
}

export function applyListingUpsert(current, listingInput) {
  const registry = validateRoleRegistry(current ?? emptyRoleRegistry());
  const nextListing = normalizeListingEntry(listingInput);
  const index = registry.listings.findIndex(
    item => item.platform === nextListing.platform && item.externalJobId === nextListing.externalJobId
  );
  const nextListings = index >= 0
    ? registry.listings.map((item, idx) => (idx === index ? nextListing : item))
    : [...registry.listings, nextListing];
  const candidate = validateRoleRegistry({ ...registry, listings: nextListings });
  const changed = index < 0 || JSON.stringify(registry.listings[index]) !== JSON.stringify(nextListing);
  return { registry: candidate, listing: nextListing, changed };
}

export function applyListingRemove(current, platform, externalJobId) {
  const registry = validateRoleRegistry(current);
  const normalizedPlatform = validatePlatform(platform);
  const normalizedJobId = singleLineText(externalJobId, '平台职位 ID', 128);
  const index = registry.listings.findIndex(
    item => item.platform === normalizedPlatform && item.externalJobId === normalizedJobId
  );
  if (index < 0) {
    throw inputError('LISTING_NOT_FOUND', `未找到平台职位映射：${normalizedPlatform}:${normalizedJobId}`, 404);
  }
  const nextListings = registry.listings.filter((_, idx) => idx !== index);
  return { registry: validateRoleRegistry({ ...registry, listings: nextListings }), removed: registry.listings[index], changed: true };
}

export function resolveRoleTarget(current, query) {
  const registry = validateRoleRegistry(current);
  const roleById = new Map(registry.roles.map(role => [role.id, role]));
  const listingsForRoles = ids => {
    const idSet = new Set(ids);
    return registry.listings.filter(listing => listing.roleIds.some(id => idSet.has(id)));
  };

  if (query.platform !== undefined || query.externalJobId !== undefined) {
    const platform = validatePlatform(query.platform);
    const externalJobId = singleLineText(query.externalJobId, '平台职位 ID', 128);
    const listing = registry.listings.find(item => item.platform === platform && item.externalJobId === externalJobId) ?? null;
    if (!listing) {
      return { matched: false, matchKind: null, policy: null, roleIds: [], roles: [], listing: null, listings: [] };
    }
    const roles = listing.roleIds.map(id => roleById.get(id));
    return {
      matched: true, matchKind: 'listing', policy: listing.policy,
      roleIds: [...listing.roleIds], roles, listing, listings: [listing]
    };
  }

  if (query.roleId !== undefined) {
    const roleId = validateRoleId(query.roleId);
    const role = roleById.get(roleId) ?? null;
    if (!role) return { matched: false, matchKind: null, policy: null, roleIds: [], roles: [], listing: null, listings: [] };
    const listings = listingsForRoles([role.id]);
    return { matched: true, matchKind: 'roleId', policy: null, roleIds: [role.id], roles: [role], listing: null, listings };
  }

  if (query.atsRequisitionId !== undefined) {
    const reqId = singleLineText(query.atsRequisitionId, 'ATS 需求单号', 80);
    const roles = registry.roles.filter(role => role.atsRequisitionId === reqId);
    if (!roles.length) return { matched: false, matchKind: null, policy: null, roleIds: [], roles: [], listing: null, listings: [] };
    const roleIds = roles.map(role => role.id);
    return { matched: true, matchKind: 'atsRequisitionId', policy: null, roleIds, roles, listing: null, listings: listingsForRoles(roleIds) };
  }

  if (query.name !== undefined) {
    const name = singleLineText(query.name, '岗位名称或别名', 300);
    const byName = registry.roles.find(role => role.name === name);
    if (byName) {
      return { matched: true, matchKind: 'name', policy: null, roleIds: [byName.id], roles: [byName], listing: null, listings: listingsForRoles([byName.id]) };
    }
    const byId = roleById.get(name);
    if (byId) {
      return { matched: true, matchKind: 'roleId', policy: null, roleIds: [byId.id], roles: [byId], listing: null, listings: listingsForRoles([byId.id]) };
    }
    const byAlias = registry.roles.find(role => (role.aliases ?? []).includes(name));
    if (byAlias) {
      return { matched: true, matchKind: 'alias', policy: null, roleIds: [byAlias.id], roles: [byAlias], listing: null, listings: listingsForRoles([byAlias.id]) };
    }
    return { matched: false, matchKind: null, policy: null, roleIds: [], roles: [], listing: null, listings: [] };
  }

  throw inputError('ROLE_REGISTRY_QUERY_INVALID', '查询条件必须指定 platform+externalJobId、roleId、name 或 atsRequisitionId 之一');
}

export function buildAliasMap(current, allowedTargets = null) {
  const registry = validateRoleRegistry(current);
  const aliases = {};
  for (const role of registry.roles) {
    if (allowedTargets && !allowedTargets.has(role.name)) continue;
    if (role.id !== role.name) aliases[role.id] = role.name;
    for (const alias of role.aliases ?? []) {
      aliases[alias] = role.name;
    }
  }
  return aliases;
}

export function diffWithContextRoles(current, contextRoles = []) {
  const registry = validateRoleRegistry(current);
  const byName = new Map(registry.roles.map(role => [role.name, role]));
  const contextByName = new Map(contextRoles.map(role => [role.name, role]));
  const onlyInContext = [];
  const onlyInRegistry = [];
  const statusMismatch = [];
  const priorityMismatch = [];

  for (const ctxRole of contextRoles) {
    const regRole = byName.get(ctxRole.name);
    if (!regRole) {
      onlyInContext.push(ctxRole.name);
      continue;
    }
    const ctxStatus = ctxRole.status ?? null;
    const regStatus = regRole.status ?? null;
    if (ctxStatus !== regStatus) {
      statusMismatch.push({ id: regRole.id, name: regRole.name, context: ctxStatus, registry: regStatus });
    }
    const ctxPriority = ctxRole.priority ?? null;
    const regPriority = regRole.priority ?? null;
    if (ctxPriority !== regPriority) {
      priorityMismatch.push({ id: regRole.id, name: regRole.name, context: ctxPriority, registry: regPriority });
    }
  }
  for (const regRole of registry.roles) {
    if (!contextByName.has(regRole.name)) {
      onlyInRegistry.push({ id: regRole.id, name: regRole.name });
    }
  }

  const inSync = onlyInContext.length === 0 && onlyInRegistry.length === 0 && statusMismatch.length === 0 && priorityMismatch.length === 0;
  return { inSync, onlyInContext, onlyInRegistry, statusMismatch, priorityMismatch };
}
