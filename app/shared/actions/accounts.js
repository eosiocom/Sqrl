import { forEach } from 'lodash';

import * as types from './types';
import eos from './helpers/eos';
import eos2 from './helpers/eos2';
import { getRexBalance } from './rex';
import EOSAccount from '../utils/EOS/Account';
import { getContactByPublicKey } from './globals';
const ecc = require('eosjs-ecc');

export function clearAccountCache() {
  return (dispatch: () => void) => {
    dispatch({
      type: types.CLEAR_ACCOUNT_CACHE
    });
  };
}

export function clearBalanceCache() {
  return (dispatch: () => void) => {
    dispatch({
      type: types.CLEAR_BALANCE_CACHE
    });
  };
}

export function refreshAccountBalances(account, requestedTokens) {
  return (dispatch: () => void) =>
    dispatch(getCurrencyBalance(account, requestedTokens));
}

export function claimUnstaked(owner) {
  return (dispatch: () => void, getState) => {
    const {
      connection
    } = getState();
    dispatch({
      type: types.SYSTEM_REFUND_PENDING
    });
    return eos(connection, true).refund({
      owner
    }).then((tx) => {
      // Reload the account
      dispatch(getAccount(owner));
      // Reload the balances
      dispatch(getCurrencyBalance(owner));
      return dispatch({
        payload: { tx },
        type: types.SYSTEM_REFUND_SUCCESS
      });
    }).catch((err) => dispatch({
      payload: { err },
      type: types.SYSTEM_REFUND_FAILURE
    }));
  };
}

export function checkAccountAvailability(account = '') {
  return (dispatch: () => void, getState) => {
    dispatch({
      type: types.SYSTEM_ACCOUNT_AVAILABLE_PENDING,
      payload: { account_name: account }
    });
    const {
      connection,
      settings
    } = getState();

    if (account && (settings.node || settings.node.length !== 0)) {
      eos(connection).getAccount(account).then(() => dispatch({
        type: types.SYSTEM_ACCOUNT_AVAILABLE_FAILURE,
        payload: { account_name: account }
      })).catch((err) => {
        if (err.status === 500) {
          dispatch({
            type: types.SYSTEM_ACCOUNT_AVAILABLE_SUCCESS,
            payload: { account_name: account }
          });
        } else {
          return dispatch({
            type: types.SYSTEM_ACCOUNT_AVAILABLE_FAILURE,
            payload: { err },
          });
        }
      });
      return;
    }
    dispatch({
      type: types.GET_ACCOUNT_AVAILABLE_FAILURE,
      payload: { account_name: account },
    });
  };
}

export function checkAccountExists(account = '') {
  return (dispatch: () => void, getState) => {
    dispatch({
      type: types.SYSTEM_ACCOUNT_EXISTS_PENDING,
      payload: { account_name: account }
    });
    const {
      connection,
      settings
    } = getState();
     if (account && (settings.node || settings.node.length !== 0)) {
      eos(connection).getAccount(account).then(() => dispatch({
        type: types.SYSTEM_ACCOUNT_EXISTS_SUCCESS,
        payload: { account_name: account }
      })).catch((err) => dispatch({
        type: types.SYSTEM_ACCOUNT_EXISTS_FAILURE,
        payload: { err }
      }));
    }
  };
}


export function getAccount(account = '') {
  return (dispatch: () => void, getState) => {
    dispatch({
      type: types.GET_ACCOUNT_REQUEST,
      payload: { account_name: account }
    });
    const {
      connection,
      settings
    } = getState();
    if (account && (settings.node || settings.node.length !== 0)) {
      eos(connection).getAccount(account).then((results) => {
        // Trigger the action to load this accounts balances'
        if (settings.account === account) {
          dispatch(getCurrencyBalance(account));
          dispatch(getRexBalance());
          if (settings.blockchain.tokenSymbol==='WAX')
            dispatch(getGenesisBalance(account));

          const model = new EOSAccount(results);
          if (model) {
            const auth = settings.authorization || 'active';
            const keys = model.getKeysForAuthorization(auth);
            if (keys && keys.length > 0) {
              const { pubkey } = keys[0];
              dispatch(getContactByPublicKey(pubkey));
            }
          }
        }
        // PATCH - Force in self_delegated_bandwidth if it doesn't exist
        const modified = Object.assign({}, results);
        if (!modified.self_delegated_bandwidth) {
          modified.self_delegated_bandwidth = {
            cpu_weight: '0.'.padEnd(settings.tokenPrecision + 2, '0') + ' ' + settings.blockchain.tokenSymbol,
            net_weight: '0.'.padEnd(settings.tokenPrecision + 2, '0') + ' ' + settings.blockchain.tokenSymbol
          };
        }
        // If a proxy voter is set, cache it's data for vote referencing
        if (modified.voter_info && modified.voter_info.proxy) {
          dispatch(getAccount(modified.voter_info.proxy));
        }
        // Dispatch the results of the account itself
        return dispatch({
          type: types.GET_ACCOUNT_SUCCESS,
          payload: { results: modified }
        });
      }).catch((err) => dispatch({
        type: types.GET_ACCOUNT_FAILURE,
        payload: { err, account_name: account },
      }));
      return;
    }
    dispatch({
      type: types.GET_ACCOUNT_FAILURE,
      payload: { account_name: account },
    });
  };
}

export function getAccounts(accounts = []) {
  return (dispatch: () => void) =>
    forEach(accounts, (account) => dispatch(getAccount(account)));
}

export function getActions(account, start, offset) {
  return (dispatch: () => void, getState) => {
    const {
      connection,
      settings,
      actions
    } = getState();

    const actionHistory = (actions && actions[account]) || { list: [] };

    dispatch({
      type: types.GET_ACTIONS_REQUEST,
      payload: { account_name: account }
    });

    if (account && (settings.node || settings.node.length !== 0)) {
      eos(connection).getActions(account, start, offset).then((results) => {
        const resultNewestAction = results.actions[results.actions.length - 1];
        const resultsNewestActionId = resultNewestAction && resultNewestAction.account_action_seq;

        const stateNewestAction = actionHistory.list[0];
        const stateNewestActionId = stateNewestAction && stateNewestAction.account_action_seq;

        if (resultsNewestActionId === stateNewestActionId) {
          return dispatch({
            type: types.GET_ACTIONS_SUCCESS,
            payload: {
              no_change: true,
              account_name: account
            }
          });
        }

        return dispatch({
          type: types.GET_ACTIONS_SUCCESS,
          payload: {
            list: mergeActionLists(actionHistory.list, results.actions),
            account_name: account
          }
        });
      }).catch((err) => dispatch({
        type: types.GET_ACTIONS_FAILURE,
        payload: { err, account_name: account },
      }));
      return;
    }
    dispatch({
      type: types.GET_ACTIONS_FAILURE,
      payload: { account_name: account },
    });
  };
}

function mergeActionLists(originalList, newActions) {
  const newList = originalList.concat(newActions);

  return newList.filter(uniqReqId).sort(sortByReqId);
}

function uniqReqId(action, index, self) {
  const actionId = action.account_action_seq;

  return self.map(actionItem => actionItem.account_action_seq).indexOf(actionId) === index;
}

function sortByReqId(actionOne, actionTwo) {
  return actionTwo.account_action_seq - actionOne.account_action_seq;
}

export function getGenesisBalance(account) {
  return (dispatch: () => void, getState) => {
    dispatch({
      type: types.GET_GENESIS_BALANCE_REQUEST
    });
    const { connection } = getState();
    const query = {
      json: true,
      code: 'eosio',
      scope: account,
      table: 'genesis',
    };
    eos(connection).getTableRows(query).then((results) => {
      let { rows } = results;
      const { 
        balance, 
        unclaimed_balance, 
        last_claim_time, 
        last_updated 
      } = rows[0];
        
      return dispatch({
        type: types.GET_GENESIS_BALANCE_SUCCESS,
        payload: {
          account: account,
          balance: balance, 
          unclaimed_balance: unclaimed_balance, 
          last_claim_time: last_claim_time, 
          last_updated: last_updated
        }
      });
    }).catch((err) => dispatch({
      type: types.GET_GENESIS_BALANCE_FAILURE,
      payload: { err },
    }));
  };
}

export function getCurrencyBalance(account, requestedTokens = false) {
  return (dispatch: () => void, getState) => {
    const {
      connection,
      settings
    } = getState();
    if (account && (settings.node || settings.node.length !== 0)) {
      const { customTokens } = settings;
      let selectedTokens = ['eosio.token:' + settings.blockchain.tokenSymbol];
      if (customTokens && customTokens.length > 0) {
        selectedTokens = [...customTokens, ...selectedTokens];
      }
      // if specific tokens are requested, use them
      if (requestedTokens) {
        selectedTokens = requestedTokens;
      }
      dispatch({
        type: types.GET_ACCOUNT_BALANCE_REQUEST,
        payload: {
          account_name: account,
          tokens: selectedTokens
        }
      });
      forEach(selectedTokens, (namespace) => {
        const [contract, symbol] = namespace.split(':');
        eos(connection).getCurrencyBalance(contract, account, symbol).then((results) =>
          dispatch({
            type: types.GET_ACCOUNT_BALANCE_SUCCESS,
            payload: {
              account_name: account,
              contract,
              precision: formatPrecisions(results),
              symbol,
              tokens: formatBalances(results, symbol)
            }
          }))
          .catch((err) => dispatch({
            type: types.GET_ACCOUNT_BALANCE_FAILURE,
            payload: { err, account_name: account }
          }));
      });
    }
  };
}

function formatPrecisions(balances) {
  const precision = {};
  for (let i = 0; i < balances.length; i += 1) {
    const [amount, symbol] = balances[i].split(' ');
    const [, suffix] = amount.split('.');
    var suffixLen = 0;
    if(suffix !== undefined) {
        suffixLen = suffix.length;
    }
    precision[symbol] = suffixLen;
  }
  return precision;
}

function formatBalances(balances, forcedSymbol = false) {
  const formatted = {};
  if (forcedSymbol) {
    formatted[forcedSymbol] = 0;
  }
  for (let i = 0; i < balances.length; i += 1) {
    const [amount, symbol] = balances[i].split(' ');
    formatted[symbol] = parseFloat(amount);
  }
  return formatted;
}

export function getAccountByKey(key) {
  return (dispatch: () => void, getState) => {
    dispatch({
      type: types.SYSTEM_ACCOUNT_BY_KEY_PENDING,
      payload: { key }
    });
    // Prevent private keys from submitting
    if (ecc.isValidPrivate(key)) {
      return dispatch({
        type: types.SYSTEM_ACCOUNT_BY_KEY_FAILURE,
      });
    }
    const {
      connection,
      settings
    } = getState();
    if (key && (settings.node || settings.node.length !== 0)) {
      eos(connection).getKeyAccounts(key).then((accounts) => {
        dispatch(getAccounts(accounts.account_names));
        return dispatch({
        type: types.SYSTEM_ACCOUNT_BY_KEY_SUCCESS,
        payload: { accounts }
      })
      }).catch((err) => dispatch({
        type: types.SYSTEM_ACCOUNT_BY_KEY_FAILURE,
        payload: { err, key }
      }));
    }
    dispatch({
      type: types.SYSTEM_ACCOUNT_BY_KEY_FAILURE,
      payload: { key },
    });
  };
}

export function clearAccountByKey() {
  return (dispatch: () => void) => {
    dispatch({
      type: types.SYSTEM_ACCOUNT_BY_KEY_CLEAR
    });
  };
}

export function claimGBMRewards() {
  return (dispatch: () => void, getState) => {
    const {
      connection,
      settings
    } = getState();

    dispatch({
      type: types.SYSTEM_CLAIMGBM_PENDING
    });

    const { account } = settings;

    // Build the operation to perform
    const op = {
      actions: [
        {
          account: 'eosio',
          name: 'claimgenesis',
          authorization: [{
            actor: account,
            permission: settings.authorization || 'active',
          }],
          data: {
            claimer: account
          },
        }
      ]
    };

    return eos2(connection, true).transact(op, {
      broadcast: true,
      blocksBehind: 3,
      expireSeconds: 120
    }).then((tx) => {
      return dispatch({
        payload: { tx },
        type: types.SYSTEM_CLAIMGBM_SUCCESS
      });
    }).catch((err) => dispatch({
      payload: { err },
      type: types.SYSTEM_CLAIMGBM_FAILURE
    }));
  };
}

export function claimVotingRewards() {
  return (dispatch: () => void, getState) => {
    const {
      connection,
      settings
    } = getState();

    dispatch({
      type: types.SYSTEM_CLAIMVOTING_PENDING
    });

    const { account } = settings;

    // Build the operation to perform
    const op = {
      actions: [
        {
          account: 'eosio',
          name: 'claimgbmvote',
          authorization: [{
            actor: account,
            permission: settings.authorization || 'active',
          }],
          data: {
            owner: account
          },
        }
      ]
    };

    return eos2(connection, true).transact(op, {
      broadcast: true,
      blocksBehind: 3,
      expireSeconds: 120
    }).then((tx) => {
      return dispatch({
        payload: { tx },
        type: types.SYSTEM_CLAIMVOTING_SUCCESS
      });
    }).catch((err) => dispatch({
      payload: { err },
      type: types.SYSTEM_CLAIMVOTING_FAILURE
    }));
  };
}

export default {
  checkAccountAvailability,
  checkAccountExists,
  claimGBMRewards,
  claimVotingRewards,
  clearAccountByKey,
  clearAccountCache,
  getAccount,
  getAccountByKey,
  getActions,
  getCurrencyBalance,
  refreshAccountBalances
};
