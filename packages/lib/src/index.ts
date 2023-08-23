// *****************************************************************************
// Copyright (C) 2022 Origin.js and others.
//
// This program and the accompanying materials are licensed under Mulan PSL v2.
// You can use this software according to the terms and conditions of the Mulan PSL v2.
// You may obtain a copy of Mulan PSL v2 at:
//          http://license.coscl.org.cn/MulanPSL2
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
// EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
// MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
// See the Mulan PSL v2 for more details.
//
// SPDX-License-Identifier: MulanPSL-2.0
// *****************************************************************************

import type {
  ConfigEnv,
  Plugin,
  UserConfig,
  ViteDevServer,
  ResolvedConfig
} from 'vite'
import virtual from '@rollup/plugin-virtual'
import { dirname } from 'path'
import { prodRemotePlugin } from './prod/remote-production'
import type { VitePluginFederationOptions } from '../types'
import { builderInfo, DEFAULT_ENTRY_FILENAME, parsedOptions } from './public'
import type { PluginHooks } from '../types/pluginHooks'
import type { ModuleInfo } from 'rollup'
import { prodSharedPlugin } from './prod/shared-production'
import { prodExposePlugin } from './prod/expose-production'
import { devSharedPlugin } from './dev/shared-development'
import { devRemotePlugin } from './dev/remote-development'
import { devExposePlugin } from './dev/expose-development'
import { Log } from './utils/tools'

export default function federation(
  options: VitePluginFederationOptions
): Plugin {
  options.filename = options.filename
    ? options.filename
    : DEFAULT_ENTRY_FILENAME

  let pluginList: PluginHooks[] = []
  let virtualMod
  let registerCount = 0

  function registerPlugins(mode: string, command: string) {
    if (mode === 'development' || command === 'serve') {
      pluginList = [
        devSharedPlugin(options),
        devExposePlugin(options),
        devRemotePlugin(options)
      ]
    } else if (mode === 'production' || command === 'build') {
      pluginList = [
        prodSharedPlugin(options),
        prodExposePlugin(options),
        prodRemotePlugin(options)
      ]
    } else {
      pluginList = []
    }
    builderInfo.isHost = !!(
      parsedOptions.prodRemote.length || parsedOptions.devRemote.length
    )
    builderInfo.isRemote = !!(
      parsedOptions.prodExpose.length || parsedOptions.devExpose.length
    )
    builderInfo.isShared = !!(
      parsedOptions.prodShared.length || parsedOptions.devShared.length
    )

    let virtualFiles = {}
    pluginList.forEach((plugin) => {
      if (plugin.virtualFile) {
        virtualFiles = Object.assign(virtualFiles, plugin.virtualFile)
      }
    })
    virtualMod = virtual(virtualFiles)
  }

  // 钩子执行顺序
  // 1.config
  // 2.configResolved
  // 3.options
  // 4.buildStart
  // 5.resolveId
  // 6.load
  // 7.transform
  // 8.moduleParsed
  // 5-8 可能会反复执行
  // 9.outputOptions
  // 10.renderChunk 每个chunk都会触发
  // 11.generateBundle

  return {
    name: 'originjs:federation',
    // for scenario vite.config.js build.cssCodeSplit: false
    // vite:css-post plugin will summarize all the styles in the style.xxxxxx.css file
    // so, this plugin need run after vite:css-post in post plugin list
    enforce: 'post', // 与插件执行顺序相关，参考 https://cn.vitejs.dev/guide/api-plugin.html#plugin-ordering
    // apply:'build',
    // 在服务器启动时被调用，第三个执行
    options(_options) {
      Log('options hook', { _options, registerCount })
      // rollup doesnt has options.mode and options.command
      if (!registerCount++) {
        registerPlugins((options.mode = options.mode ?? 'production'), '')
      }

      if (typeof _options.input === 'string') {
        _options.input = { index: _options.input }
      }
      _options.external = _options.external || []
      if (!Array.isArray(_options.external)) {
        _options.external = [_options.external as string]
      }
      for (const pluginHook of pluginList) {
        pluginHook.options?.call(this, _options)
      }
      return _options
    },
    // 在解析配置前调用，接收原始用户配置
    config(config: UserConfig, env: ConfigEnv) {
      Log('config hook', config)

      options.mode = options.mode ?? env.mode
      // registerPlugins 的两个参数都有，会对pluginList进行赋值
      registerPlugins(options.mode, env.command)
      registerCount++
      for (const pluginHook of pluginList) {
        pluginHook.config?.call(this, config, env)
      }

      // only run when builder is vite,rollup doesnt has hook named `config`
      builderInfo.builder = 'vite'
      builderInfo.assetsDir = config?.build?.assetsDir ?? 'assets'
    },
    // 在创建开发服务器之前执行，build下不执行
    configureServer(server: ViteDevServer) {
      Log('configureServer hook')
      for (const pluginHook of pluginList) {
        pluginHook.configureServer?.call(this, server)
      }
    },
    // 在解析 Vite 配置后调用
    configResolved(config: ResolvedConfig) {
      Log('configResolved hook')
      for (const pluginHook of pluginList) {
        pluginHook.configResolved?.call(this, config)
      }
    },
    buildStart(inputOptions) {
      Log('buildStart hook')
      for (const pluginHook of pluginList) {
        pluginHook.buildStart?.call(this, inputOptions)
      }
    },
    // 在解析模块路径时执行
    async resolveId(...args) {
      Log('resolveId hook', args[0])
      const v = virtualMod.resolveId.call(this, ...args)
      if (v) {
        return v
      }
      if (args[0] === '\0virtual:__federation_fn_import') {
        return {
          id: '\0virtual:__federation_fn_import',
          moduleSideEffects: true
        }
      }
      if (args[0] === '__federation_fn_satisfy') {
        const federationId = (
          await this.resolve('@originjs/vite-plugin-federation')
        )?.id
        return await this.resolve(`${dirname(federationId!)}/satisfy.mjs`)
      }
      return null
    },
    // 加载模块时执行
    load(...args) {
      Log('load hook', args[0])
      const v = virtualMod.load.call(this, ...args)
      if (v) {
        return v
      }
      return null
    },
    // 加载模块之后执行
    transform(code: string, id: string) {
      Log('transform hook', { id })
      for (const pluginHook of pluginList) {
        const result = pluginHook.transform?.call(this, code, id)
        if (result) {
          return result
        }
      }
      return code
    },
    // 如果定义了moduleParsed钩子，则在transform之后执行
    moduleParsed(moduleInfo: ModuleInfo): void {
      Log('moduleParsed hook', moduleInfo.moduleName)
      for (const pluginHook of pluginList) {
        pluginHook.moduleParsed?.call(this, moduleInfo)
      }
    },
    outputOptions(outputOptions) {
      Log('outputOptions hook', outputOptions)
      for (const pluginHook of pluginList) {
        pluginHook.outputOptions?.call(this, outputOptions)
      }
      return outputOptions
    },

    renderChunk(code, chunkInfo, _options) {
      Log('renderChunk hook')
      for (const pluginHook of pluginList) {
        const result = pluginHook.renderChunk?.call(
          this,
          code,
          chunkInfo,
          _options
        )
        if (result) {
          return result
        }
      }
      return null
    },

    generateBundle: function (_options, bundle, isWrite) {
      Log('generateBundle hook')
      for (const pluginHook of pluginList) {
        pluginHook.generateBundle?.call(this, _options, bundle, isWrite)
      }
    }
  }
}
