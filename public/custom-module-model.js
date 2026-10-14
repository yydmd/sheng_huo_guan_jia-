(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.CustomModuleModel = model;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const icons = ['book-open', 'folder', 'lightbulb', 'target', 'star'];
  const builtins = ['重要时间点', '原则打卡', '问题拆解', '计划', '所思', '个人模板', '学习专区', '核心思想', '复盘'];
  const reserved = ['设置', '当前界面', '专区界面'];
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const moduleId = /^custom-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const key = (name) => name.trim().normalize('NFKC').toLowerCase();
  const dataError = (message) => Object.assign(new Error(message), { code: 'CUSTOM_MODULE_DATA_INVALID' });
  function nameError(value, modules = []) {
    if (typeof value !== 'string' || !value.trim()) return '请输入模块名称';
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) return '模块名称不能包含换行或控制字符';
    if ([...value.trim()].length > 20) return '模块名称最多20个字符';
    const names = [...builtins, ...reserved, ...modules.map((entry) => entry.name)];
    if (names.some((name) => key(name) === key(value))) return '模块名称已存在或为保留名称';
    return '';
  }
  function validate(modules, schema) {
    if (!Array.isArray(modules)) throw dataError('自定义模块数据格式错误，原文件已保留');
    if (schema !== undefined && schema !== 1) throw dataError('自定义模块数据版本不支持，原文件已保留');
    const seen = new Set(), requests = new Set(), checked = [];
    const stamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
    for (const entry of modules) {
      if (!entry || typeof entry.id !== 'string' || !moduleId.test(entry.id) || seen.has(entry.id) || entry.kind !== 'categorized-library'
        || !icons.includes(entry.icon) || !['main', 'zone'].includes(entry.defaultPlacement)
        || !stamp(entry.createdAt) || typeof entry.creationRequestId !== 'string' || !uuid.test(entry.creationRequestId) || requests.has(entry.creationRequestId)
        || !Number.isInteger(entry.createdNavigationRevision) || entry.createdNavigationRevision < 1
        || nameError(entry.name, checked) || entry.name !== entry.name.trim()
        || !Array.isArray(entry.categories) || !Array.isArray(entry.templates)) {
        throw dataError('自定义模块数据格式错误，原文件已保留');
      }
      const categoryIds = new Set(), categoryNames = new Set(), templateIds = new Set();
      for (const category of entry.categories) {
        if (!category || typeof category.id !== 'string' || !category.id || categoryIds.has(category.id)
          || typeof category.name !== 'string' || !category.name.trim() || categoryNames.has(category.name.trim().toLocaleLowerCase()) || !stamp(category.createdAt)) {
          throw dataError('自定义分类数据格式错误，原文件已保留');
        }
        categoryIds.add(category.id); categoryNames.add(category.name.trim().toLocaleLowerCase());
      }
      for (const template of entry.templates) {
        if (!template || typeof template.id !== 'string' || !template.id || templateIds.has(template.id)
          || typeof template.name !== 'string' || !template.name.trim() || typeof template.content !== 'string'
          || typeof template.note !== 'string' || !stamp(template.createdAt) || !stamp(template.updatedAt)
          || (template.categoryId !== null && !categoryIds.has(template.categoryId))) {
          throw dataError('自定义模板数据格式错误，原文件已保留');
        }
        templateIds.add(template.id);
      }
      seen.add(entry.id); requests.add(entry.creationRequestId); checked.push(entry);
    }
    return modules;
  }
  return { icons, uuid, moduleId, key, nameError, validate };
});
