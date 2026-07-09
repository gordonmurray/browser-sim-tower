import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const phaserFreeZone = {
  files: ['src/core/**/*.ts', 'src/save/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [{ name: 'phaser', message: 'src/core and src/save must stay Phaser-free.' }],
        patterns: [
          { group: ['phaser', 'phaser/*'], message: 'src/core and src/save must stay Phaser-free.' },
          { group: ['**/game/**'], message: 'src/core and src/save must not import from src/game.' },
        ],
      },
    ],
  },
};

export default tseslint.config(
  { ignores: ['dist', 'node_modules', '*.config.ts', '*.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  phaserFreeZone,
);
