import type { Config } from 'prettier'

const config: Config = {
  printWidth: 140,
  tabWidth: 2,
  useTabs: false,
  semi: false,
  singleQuote: true,
  proseWrap: 'never',
  trailingComma: 'none',
  overrides: [
    {
      files: '*.md',
      options: {
        parser: 'markdown'
      }
    }
  ]
}

export default config
