import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.cache/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        performance: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly'
      }
    }
  },
  {
    // CommonJS scripts run by GitHub Actions (actions/github-script, node --test).
    files: ['.github/scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly' }
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  },
  {
    // The phone page runs in the browser.
    files: ['packages/remote/src/phone/web/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        history: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly'
      }
    }
  }
)
