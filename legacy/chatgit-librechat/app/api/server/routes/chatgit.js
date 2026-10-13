const { createChatGitRouter, resolveLocalAccessConfig } = require('@librechat/api');
const { getUserById, countUsers, createUserWithIdIfAbsent } = require('~/models');
const { setAuthTokens } = require('~/server/services/AuthService');
const { getAppConfig } = require('~/server/services/Config');
const { requireJwtAuth } = require('~/server/middleware');

module.exports = createChatGitRouter({
  config: resolveLocalAccessConfig(process.env),
  getUserById: (userId) => getUserById(userId),
  countUsers: () => countUsers(),
  createUserWithIdIfAbsent,
  getBalanceConfig: async () => (await getAppConfig({ baseOnly: true }))?.balance,
  setAuthTokens,
  requireJwtAuth,
});
