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

import { Log } from '../utils/tools'
import type { PluginHooks } from '../../types/pluginHooks'
import { NAME_CHAR_REG, parseSharedOptions, removeNonRegLetter } from '../utils'
import { builderInfo, parsedOptions } from '../public'
import type { ConfigTypeSet, VitePluginFederationOptions } from 'types'
import { basename, join, resolve } from 'path'
import { readdirSync, readFileSync, statSync } from 'fs'
const sharedFilePathReg = /__federation_shared_(.+)\.js$/
// 参考 https://cn.vitejs.dev/guide/assets.html#importing-asset-as-string
// ?raw后缀会将文件以字符串的形式引入，即 federation_fn_import 是包含 federation_fn_import.js 内容的字符串
import federation_fn_import from './federation_fn_import.js?raw'

export function prodSharedPlugin(
  options: VitePluginFederationOptions
): PluginHooks {
  Log('prodSharedPlugin parsedOptions', parsedOptions)

  // parsedOptions.prodShared = [["依赖名", { 依赖配置 }], ...]
  parsedOptions.prodShared = parseSharedOptions(options)

  Log('parsedOptions.prodShared', JSON.stringify(parsedOptions.prodShared))

  // 将二维数组转成对象
  const shareName2Prop = new Map<string, any>()
  parsedOptions.prodShared.forEach((value) =>
    shareName2Prop.set(removeNonRegLetter(value[0], NAME_CHAR_REG), value[1])
  )

  let isHost
  let isRemote
  const id2Prop = new Map<string, any>()

  return {
    name: 'originjs:shared-production',
    // 可能和创建 federation_fn_import.js 文件有关
    virtualFile: {
      __federation_fn_import: federation_fn_import
    },
    // options 钩子主要作用是：
    // 1.初始化当前是 host 还是 remote
    // 2.从 rollup external 中移除 shared 依赖，移除的原因是 rollup 需要对 shared 依赖进行处理
    options(inputOptions) {
      Log('parsedOptions', parsedOptions)
      // 判断是host还是remote
      isRemote = !!parsedOptions.prodExpose.length
      isHost =
        !!parsedOptions.prodRemote.length && !parsedOptions.prodExpose.length

      if (shareName2Prop.size) {
        // remove item which is both in external and shared
        // rollup构建时，从 external 中移除 shared 依赖
        inputOptions.external = (inputOptions.external as [])?.filter(
          (item) => {
            return !shareName2Prop.has(removeNonRegLetter(item, NAME_CHAR_REG))
          }
        )
      }
      return inputOptions
    },

    // 在rollup构建开始前执行的钩子
    // 主要作用是：
    // 1.补全 shared 中依赖的版本
    // 2.生成 __federation_fn_import.js 文件
    async buildStart() {
      // Cannot emit chunks after module loading has finished, so emitFile first.
      if (parsedOptions.prodShared.length && isRemote) {
        // emitFile 是 rollup 在构建过程中生成文件的方法
        // 此处用于生成 __federation_fn_import.js
        this.emitFile({
          fileName: `${
            builderInfo.assetsDir ? builderInfo.assetsDir + '/' : ''
          }__federation_fn_import.js`,
          type: 'chunk',
          id: '__federation_fn_import',
          preserveSignature: 'strict'
        })
      }

      // forEach and collect dir
      const collectDirFn = (filePath: string, collect: string[]) => {
        const files = readdirSync(filePath)
        files.forEach((name) => {
          const tempPath = join(filePath, name)
          const isDir = statSync(tempPath).isDirectory()
          if (isDir) {
            collect.push(tempPath)
            collectDirFn(tempPath, collect)
          }
        })
      }

      const monoRepos: { arr: string[]; root: string | ConfigTypeSet }[] = []
      const dirPaths: string[] = []
      const currentDir = resolve()

      //  try to get every module package.json file
      for (const arr of parsedOptions.prodShared) {
        if (isHost && !arr[1].version && !arr[1].manuallyPackagePathSetting) {
          // host中的依赖，在没有配置 version、且没有配置 packagePath 的情况下
          // 先尝试从依赖的 package.json 中获取 version
          // 如果获取不到依赖的 package.json，则将其从 parsedOptions.prodShared 中移除，并添加到 monoRepos

          // 获取依赖package.json的路径
          const packageJsonPath = (
            await this.resolve(`${arr[1].packagePath}/package.json`)
          )?.id

          if (packageJsonPath) {
            const packageJson = JSON.parse(
              readFileSync(packageJsonPath, { encoding: 'utf-8' })
            )
            arr[1].version = packageJson.version
          } else {
            arr[1].removed = true
            const dir = join(currentDir, 'node_modules', arr[0])
            const dirStat = statSync(dir)
            if (dirStat.isDirectory()) {
              collectDirFn(dir, dirPaths)
            } else {
              this.error(`cant resolve "${arr[1].packagePath}"`)
            }

            if (dirPaths.length > 0) {
              monoRepos.push({ arr: dirPaths, root: arr })
            }
          }

          if (!arr[1].removed && !arr[1].version) {
            this.error(
              `No description file or no version in description file (usually package.json) of ${arr[0]}. Add version to description file, or manually specify version in shared config.`
            )
          }
        }
      }

      // 移除找不到 pacakge.json 的依赖
      parsedOptions.prodShared = parsedOptions.prodShared.filter(
        (item) => !item[1].removed
      )

      // 对于找不到 package.json 的依赖
      // assign version to monoRepo
      if (monoRepos.length > 0) {
        for (const monoRepo of monoRepos) {
          for (const id of monoRepo.arr) {
            try {
              const idResolve = await this.resolve(id)
              if (idResolve?.id) {
                (parsedOptions.prodShared as any[]).push([
                  `${monoRepo.root[0]}/${basename(id)}`, // basename返回带扩展的文件名
                  {
                    id: idResolve?.id,
                    import: monoRepo.root[1].import,
                    shareScope: monoRepo.root[1].shareScope,
                    root: monoRepo.root
                  }
                ])
              }
            } catch (e) {
              //    ignore
            }
          }
        }
      }

      // id2Prop 没有导出，也没有在其他地方使用，下面的代码没有实际作用
      if (parsedOptions.prodShared.length && isRemote) {
        for (const prod of parsedOptions.prodShared) {
          id2Prop.set(prod[1].id, prod[1])
        }
      }
    },
    // rollup outputOptions钩子，用于操作 output 配置
    // 主要作用是配置 rollup output.manualChunks，将 shared 依赖的依赖单独打包
    outputOptions: function (outputOption) {
      // remove rollup generated empty imports,like import './filename.js'
      // 传递依赖的导入语句将保持在原来的位置，不会被提升
      // 参考 https://www.rollupjs.com/guide/faqs/#%E4%B8%BA%E4%BB%80%E4%B9%88%E8%BF%9B%E8%A1%8C%E4%BB%A3%E7%A0%81%E6%8B%86%E5%88%86%E6%97%B6%E6%88%91%E7%9A%84%E5%85%A5%E5%8F%A3-chunk-%E5%87%BA%E7%8E%B0%E4%BA%86%E5%85%B6%E5%AE%83%E7%9A%84%E5%AF%BC%E5%85%A5
      outputOption.hoistTransitiveImports = false

      const manualChunkFunc = (id: string) => {
        //  if id is in shared dependencies, return id ,else return vite function value
        const find = parsedOptions.prodShared.find((arr) =>
          arr[1].dependencies?.has(id)
        )

        // 返回一个 chunk 的名称或 undefined
        // 前者将依赖打包到对应名称的 chunk 中，后者使用默认的分割策略
        return find ? find[0] : undefined
      }

      // only active when manualChunks is function,array not to solve
      if (typeof outputOption.manualChunks === 'function') {
        outputOption.manualChunks = new Proxy(outputOption.manualChunks, {
          apply(target, thisArg, argArray) {
            const result = manualChunkFunc(argArray[0])
            return result ? result : target(argArray[0], argArray[1])
          }
        })
      }

      // The default manualChunk function is no longer available from vite 2.9.0
      if (outputOption.manualChunks === undefined) {
        outputOption.manualChunks = manualChunkFunc
      }

      return outputOption
    },
    // rollup generateBundle 钩子，用于在生成最终输出捆绑包时执行定制操作
    // 主要作用是删除 shared 中 generate  为 false 的依赖，即在 remote 设置不生成共享文件
    generateBundle(options, bundle) {
      if (!isRemote) {
        return
      }
      const needRemoveShared = new Set<string>()
      for (const key in bundle) {
        const chunk = bundle[key]
        if (chunk.type === 'chunk') {
          if (!isHost) {
            const regRst = sharedFilePathReg.exec(chunk.fileName)
            if (regRst && shareName2Prop.get(regRst[1])?.generate === false) {
              needRemoveShared.add(key)
            }
          }
        }
      }
      if (needRemoveShared.size !== 0) {
        for (const key of needRemoveShared) {
          delete bundle[key]
        }
      }
    }
  }
}
