import { MakerZIP } from '@electron-forge/maker-zip'
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives'
import { FusesPlugin } from '@electron-forge/plugin-fuses'
import { VitePlugin } from '@electron-forge/plugin-vite'
import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { identityForChannel } from '../../packages/contract/src/identity.ts'

const identity = identityForChannel(process.env.BUILD_CHANNEL === 'stable' ? 'stable' : 'dev')
const require = createRequire(import.meta.url)
const sqlitePackage = resolve(require.resolve('better-sqlite3/package.json'), '..')

export default {
  hooks: {
    postPackage: async (_config, packageResult) => {
      for (const outputPath of packageResult.outputPaths ?? []) {
        const target = resolve(outputPath, 'resources', 'node_modules', 'better-sqlite3')
        mkdirSync(resolve(target, '..'), { recursive: true })
        cpSync(sqlitePackage, target, { recursive: true })
        const serviceBundle = resolve(outputPath, 'resources', 'svc-db.cjs')
        const bundle = readFileSync(serviceBundle, 'utf8')
        writeFileSync(serviceBundle, bundle.replaceAll('require("better-sqlite3")', 'require("./node_modules/better-sqlite3")'))
      }
    },
  },
  packagerConfig: {
    asar: true,
    name: identity.appDirName,
    appBundleId: identity.appId,
    extraResource: [
      resolve(import.meta.dirname, 'src/main/supervisor/job-object.ps1'),
      resolve(import.meta.dirname, '../../packages/data/migrations'),
      resolve(import.meta.dirname, '.vite/renderer'),
      resolve(import.meta.dirname, '.vite/build/svc-db.cjs'),
    ],
  },
  makers: [
    {
      name: '@felixrieseberg/electron-forge-maker-nsis',
      config: {
        getAppBuilderConfig: async () => ({
          appId: identity.appId,
          productName: identity.appDirName,
          executableName: identity.appDirName,
          artifactName: `${identity.appDirName}-setup-${'${version}'}.${'${ext}'}`,
          nsis: {
            oneClick: false,
            perMachine: false,
            allowElevation: false,
            allowToChangeInstallationDirectory: false,
            include: resolve(import.meta.dirname, 'installer/uninstall-data.nsh'),
            shortcutName: identity.displayName,
            uninstallDisplayName: identity.displayName,
          },
        }),
      },
    },
    new MakerZIP({}, ['win32']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts' },
        { entry: '../svc-db/src/index.ts', config: '../svc-db/vite.config.ts' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
}
