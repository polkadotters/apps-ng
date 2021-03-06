import { types, flow } from 'mobx-state-tree'
import { ss58ToHex, hexToSs58 } from '@phala/runtime'
import * as Crypto from '@phala/runtime/crypto'
import PRuntime from '@phala/runtime'
import { toJS } from 'mobx'

import { cryptoWaitReady } from '@polkadot/util-crypto'
import keyring from '@polkadot/ui-keyring'
import { CONTRACT_BALANCE, CONTRACT_ASSETS } from '@phala/wallet/utils/constants'

const anyType = types.custom({
  isTargetType: () => true,
  getValidationMessage: () => '',
  fromSnapshot: val => val,
  toSnapshot: val => val
})

export const createWalletRuntimeStore = (defaultValue = {}) => {
  const WalletRuntimeStore = types
    .model('WalletStore', {
      ecdhChannel: types.maybeNull(anyType),
      ecdhShouldJoin: types.optional(types.boolean, false),
      latency: types.optional(types.number, 0),
      info: types.maybeNull(anyType),
      error: types.maybeNull(anyType),
      pApi: types.maybeNull(anyType),
      assets: types.array(anyType),
      mainAsset: types.maybeNull(anyType),
    })
    .views(self => ({
      get runtimeEndpointUrl () {
        return self.appSettings.phalaTeeApiUrl
      },
      get appSettings () {
        return defaultValue.appSettings
      },
      get appAccount () {
        return defaultValue.appAccount
      },
      get accountId () {
        return self.appAccount.address
      },
      get keypair () {
        return self.appAccount.keypair
      },
      get accountIdHex () {
        if (!self.accountId) { return null }
        return ss58ToHex(self.accountId)
      },
      get channelReady () {
        if (!self.ecdhChannel || !self.ecdhChannel.core.agreedSecret || !self.ecdhChannel.core.remotePubkey) {
          console.warn('ECDH not ready')
          return false
        }
        if (!self.keypair || self.keypair.isLocked) {
          console.warn('Account not ready')
          return false
        }
        if (!self.pApi) {
          console.warn('pRuntime not ready')
          return false
        }
        return true
      },
      get assetSymbols () {
        const ret = self.assets.map(i => i.metadata.symbol)
        ret.push('PHA')
        return ret
      }
    }))
    .actions(self => ({
      checkChannelReady () {
        if (!self.ecdhChannel || !self.ecdhChannel.core.agreedSecret || !self.ecdhChannel.core.remotePubkey) {
          throw new Error('ECDH not ready')
        }
        if (!self.keypair || self.keypair.isLocked) {
          throw new Error('Account not ready')
        }
        if (!self.pApi) {
          throw new Error('pRuntime not ready')
        }
      },
      async query (name, getPayload, contractId = 1) {
        self.checkChannelReady()
        const data = getPayload ? { [name]: getPayload() } : name
        return self.pApi.query(contractId, data)
      },
      initEcdhChannel: flow(function* () {
        const ch = yield Crypto.newChannel()
        self.ecdhChannel = ch
        self.ecdhShouldJoin = true
      }),
      joinEcdhChannel: flow(function* () {
        const ch = yield Crypto.joinChannel(self.ecdhChannel, self.info.ecdhPublicKey)
        self.ecdhChannel = ch
        self.ecdhShouldJoin = false
        console.log('joined channel:', toJS(ch))
      }),
      initPApi (endpoint) {
        self.pApi = new PRuntime({
          endpoint,
          channel: self.ecdhChannel,
          keypair: self.keypair
        })
      },
      resetNetwork () {
        self.error = null
        self.latency = 0
        self.info = null
      },
      setInfo (i) {
        self.info = i
      },
      setError (e) {
        self.error = e
      },
      setLatency (dt) {
        self.latency = parseInt((l => l ? l * 0.8 + dt * 0.2 : dt)(self.latency))
      },
      fullUpdate: flow(function* () {
        yield self.updateMainAsset()
        yield self.updateAssets()
      }),
      updateMainAsset: flow(function* () {
        const res = yield self.query(
          'FreeBalance',
          () => ({ account: self.accountIdHex }),
          CONTRACT_BALANCE
        )
        self.mainAsset = {
          ...self.mainAsset, 
          balance: res?.FreeBalance?.balance || '0'
        }
      }),
      updateAssets: flow(function* () {
        const res = yield self.query(
          'ListAssets',
          () => ({ availableOnly: false }),
          CONTRACT_ASSETS
        )
        self.assets = (res?.ListAssets?.assets || []).reverse()
      })
    }))

  return WalletRuntimeStore.create(defaultValue)
}
