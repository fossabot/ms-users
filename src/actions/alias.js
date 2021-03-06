const Promise = require('bluebird');
const Errors = require('common-errors');
const { getInternalData } = require('../utils/userData');
const isActive = require('../utils/isActive.js');
const isBanned = require('../utils/isBanned.js');
const key = require('../utils/key.js');
const handlePipeline = require('../utils/pipelineError.js');
const {
  USERS_DATA,
  USERS_METADATA,
  USERS_ALIAS_TO_ID,
  USERS_ID_FIELD,
  USERS_ALIAS_FIELD,
  USERS_PUBLIC_INDEX,
  lockAlias,
} = require('../constants.js');

/**
 * @api {amqp} <prefix>.alias Add alias to user
 * @apiVersion 1.0.0
 * @apiName AddAlias
 * @apiGroup Users
 *
 * @apiDescription Adds alias to existing username. This alias must be unique across system, as
 * well as obide strict restrictions - ascii chars only, include numbers and dot. It's used to obfuscate
 * username in public interfaces
 *
 * @apiParam (Payload) {String} username - currently email of the user
 * @apiParam (Payload) {String{3..15}} alias - chosen alias
 *
 */
module.exports = function assignAlias(request) {
  const { redis, config: { jwt: { defaultAudience } } } = this;
  const { username, internal } = request.params;

  // lowercase alias
  const alias = request.params.alias.toLowerCase();

  return Promise
    .bind(this, username)
    .then(getInternalData)
    .tap(isBanned)
    .then((data) => {
      if (data[USERS_ALIAS_FIELD]) {
        throw new Errors.HttpStatusError(417, 'alias is already assigned');
      }

      const userId = data[USERS_ID_FIELD];

      // perform set alias
      const setAlias = active => redis
        .hsetnx(USERS_ALIAS_TO_ID, alias, userId)
        .then((assigned) => {
          if (assigned === 0) {
            const err = new Errors.HttpStatusError(409, `"${alias}" already exists`);
            err.code = 'E_ALIAS_CONFLICT';
            return Promise.reject(err);
          }

          const pipeline = redis
            .pipeline()
            .hset(key(userId, USERS_DATA), USERS_ALIAS_FIELD, alias)
            .hset(key(userId, USERS_METADATA, defaultAudience), USERS_ALIAS_FIELD, JSON.stringify(alias));

          if (active) {
            pipeline.sadd(USERS_PUBLIC_INDEX, username);
          }

          return pipeline
            .exec()
            .then(handlePipeline);
        });

      // determine if user is active
      const activeUser = isActive(data, true);

      // if we access assign alias from register user
      // we do not need the lock
      if (internal) {
        return setAlias(activeUser);
      } else if (!activeUser) {
        throw new Errors.HttpStatusError(412, 'Account hasn\'t been activated');
      }

      return this.dlock
        .once(lockAlias(alias))
        .then(lock => setAlias(activeUser).finally(() => {
          lock.release().reflect();
          return null;
        }));
    });
};

module.exports.transports = [require('@microfleet/core').ActionTransport.amqp];
